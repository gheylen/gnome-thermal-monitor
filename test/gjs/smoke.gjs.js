// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The real registry, the real Gio port, and this machine's actual /sys.
//
// Every other test in this project substitutes something: the Node suites use an
// in-memory sysfs, and the GJS suites use either that fake or a tree they built
// themselves. Nothing had ever pointed the shipped code at a real kernel.
//
// What this can assert is limited on purpose, because what it finds depends
// entirely on the machine: a container has no hwmon at all, a laptop has several.
// So it asserts the properties that must hold either way — discovery does not
// throw, ids are unique and well-formed, a poll produces a coherent snapshot,
// every string is renderable — and then *prints* what it found.
//
// That printout is the point. Run `make test-gjs` on a real laptop and this
// reports the verdicts the panel would show, from the hardware in front of you.
// It is the shortest path from "no machine has ever run this" (see BACKLOG.md)
// to a bug report someone can act on.

import {Confidence} from '../../src/domain/confidence.js';
import {discoverComponents} from '../../src/domain/discovery.js';
import {Monitor} from '../../src/domain/monitor.js';
import {Thresholds} from '../../src/domain/thresholds.js';
import {CATEGORY_WARNINGS, DRIVERS} from '../../src/hardware/index.js';
import {
    componentLines, panelAccessibleName, panelLabel, sectionTitle, throttleNotification,
} from '../../src/presentation.js';
import {gioSysfs} from '../../src/sysfs/gio.js';
import {announce, check, equal, finish} from './harness.js';

announce('smoke');

const LEVELS = new Set(Object.values(Confidence));

// ── Discovery, against whatever this machine has ───────────────────────────

const warnings = [];
let discovery = null;
try {
    discovery = discoverComponents(DRIVERS, gioSysfs, message => warnings.push(message));
} catch (error) {
    check('discovery does not throw on real hardware', false, String(error));
}

if (discovery !== null) {
    check('discovery does not throw on real hardware', true);

    const {components, missingCategories} = discovery;
    print(`#   found ${components.length} component(s) on this machine`);
    for (const message of warnings) print(`#   warning: ${message}`);
    for (const category of missingCategories) {
        const message = CATEGORY_WARNINGS[category];
        print(`#   no ${category}${message ? ` — ${message}` : ' (optional; not reported)'}`);
    }

    const ids = components.map(component => component.id);
    equal('component ids are unique', new Set(ids).size, ids.length);
    check('component ids are shaped <category>:<driver>[:<index>]',
        ids.every(id => /^[a-z]+:[a-z0-9]+(:\d+)?$/.test(id)), ids.join(', '));
    check('every component has a title that renders',
        components.every(component => sectionTitle(component.title).length > 0));

    // ── A poll, end to end ─────────────────────────────────────────────────

    const monitor = new Monitor(components, {now: () => 0});
    const thresholds = new Thresholds(88, 94);

    let snapshot = null;
    try {
        monitor.poll(thresholds);   // prime the delta window
        snapshot = monitor.poll(thresholds);
    } catch (error) {
        check('a poll does not throw', false, String(error));
    }

    if (snapshot !== null) {
        check('a poll does not throw', true);
        check('the snapshot level is part of the vocabulary', LEVELS.has(snapshot.level),
            String(snapshot.level));
        check('the panel label renders', panelLabel(snapshot).length > 0);
        check('the accessible name renders', panelAccessibleName(snapshot).length > 0);
        check('a machine with no components is UNKNOWN, never "all clear"',
            components.length > 0 || snapshot.level === Confidence.UNKNOWN);
        // "?°C" would claim a sensor that failed; there is none here to fail.
        check('a machine with no components does not claim an unread sensor',
            components.length > 0 || !panelLabel(snapshot).includes('?'),
            panelLabel(snapshot));

        // The notification is the one user-visible string a nominal machine
        // never produces, so nothing else here would ever build it. It is
        // wording, not an edge: on this machine it says whichever component is
        // throttling, or the fallback when none is.
        const notification = throttleNotification(snapshot);
        check('the notification renders',
            notification.title.length > 0 && notification.body.length > 0);

        print(`#   panel: ${panelLabel(snapshot)}`);
        print(`#   spoken: ${panelAccessibleName(snapshot)}`);
        print(`#   would notify: ${notification.title} — ${notification.body}`);
        for (const component of snapshot.components) {
            const {status, detail} = componentLines(component);
            check(`${component.id} produces a level in the vocabulary`,
                LEVELS.has(component.level), String(component.level));
            check(`${component.id} produces a non-empty summary`, status.trim().length > 0);
            print(`#   ${sectionTitle(component.title)}: ${status}${detail ? ` /${detail}` : ''}`);
        }

        // Reassessment must be as safe as a poll: it is what a settings change
        // runs, and it runs inside the compositor just the same.
        try {
            const reassessed = monitor.reassess(new Thresholds(70, 75));
            check('a reassessment does not throw', reassessed !== null);
        } catch (error) {
            check('a reassessment does not throw', false, String(error));
        }
    }
}

finish('smoke');
