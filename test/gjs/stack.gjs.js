// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The pure layers, run on the engine that actually ships them.
//
// Every other test of `src/domain/` and `src/presentation.js` runs under Node.
// That proves the logic, not that SpiderMonkey accepts the syntax: GJS and Node
// track different ECMAScript releases, and a private class field or a newer
// built-in that Node accepts can fail to parse in the shell — where the failure
// surfaces as an extension that will not enable, with no test to catch it.
//
// So this walks a described machine through discovery, the Monitor and the
// presentation under `gjs`, and checks the verdict it produces — and confirms
// that the two entry points parse there, which is the one thing about them a
// test outside GNOME can establish.
//
// Run with `make test-gjs`. The `.gjs.js` suffix keeps it out of the Node runner.

import {Confidence} from '../../src/domain/confidence.js';
import {discoverComponents} from '../../src/domain/discovery.js';
import {Monitor} from '../../src/domain/monitor.js';
import {Thresholds} from '../../src/domain/thresholds.js';
import {DRIVERS} from '../../src/hardware/index.js';
import {componentLines, panelAccessibleName, panelLabel} from '../../src/presentation.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';
import {announce, equal, finish, standingAgainstFloor} from './harness.js';

announce('gjs stack');

// ── A two-core Intel machine, running hot, with one core throttling ────────

const CORE = core => `/sys/devices/system/cpu/cpu${core}/thermal_throttle`;
const files = {
    ...filesIn('/sys/class/hwmon/hwmon4', {
        name: 'coretemp', temp1_label: 'Package id 0',
        temp1_input: '92000', temp1_crit: '100000',
    }),
    ...filesIn(CORE(0), {core_throttle_count: '3', core_throttle_total_time_ms: '100'}),
    ...filesIn(CORE(1), {core_throttle_count: '3', core_throttle_total_time_ms: '100'}),
};

const {components, missingCategories} = discoverComponents(DRIVERS, fakeSysfs({files}));
equal('discovery finds the CPU', components.map(c => c.id).join(','), 'cpu:intel');
equal('discovery reports the absent categories', missingCategories.join(','), 'gpu,npu');

const ordered = new Thresholds(94, 88);
equal('thresholds are ordered whichever way they arrive', ordered.warnC, 88);
equal('and the higher one is critical', ordered.critC, 94);

let clock = 0;
const monitor = new Monitor(components, {now: () => clock, lingerMs: 30_000});
const thresholds = new Thresholds(88, 94);

monitor.poll(thresholds);                       // prime the delta window
files[`${CORE(0)}/core_throttle_count`] = '4';  // core 0 enters a throttle
const snapshot = monitor.poll(thresholds);

equal('an advancing thermal counter is CONFIRMED', snapshot.level, Confidence.CONFIRMED);
equal('the panel names the throttling core count', panelLabel(snapshot), '⚠ 92°C (1)');
equal('the accessible name speaks the state and the count', panelAccessibleName(snapshot),
    'Thermal throttle monitor: throttling, CPU 92 degrees Celsius, 1 core throttling');
equal('the notification edge fires', snapshot.throttleStarted, true);
equal('the linger deadline is set from the injected clock', snapshot.lingerUntilMs, 30_000);

const lines = componentLines(snapshot.components[0]);
equal('the popup badge renders', lines.status, '████ CONFIRMED   92°C');
equal('the popup detail renders', lines.detail, '  1 of 2 cores throttling — thermal (TCC)');

// The burst ends; the panel holds, then clears.
clock = 29_999;
equal('the panel holds red through the linger window', monitor.poll(thresholds).level,
    Confidence.CONFIRMED);
clock = 30_001;
const cooled = monitor.poll(thresholds);
equal('the panel clears once the linger expires', cooled.level, Confidence.MEDIUM);

// The newest and most arithmetic of the rules, evaluated on the engine that
// ships it: 92 °C against a TjMax of 100 °C is eight degrees of headroom, which
// is inside the kernel's own ten-degree band and so MEDIUM on the hardware's
// account rather than the user's.
equal('the temperature tier reports headroom, not an absolute number',
    componentLines(cooled.components[0]).detail,
    '  8°C below the throttle point (100°C)');

// ── The entry points ───────────────────────────────────────────────────────

// extension.js and prefs.js cannot run outside GNOME — they import `St` and the
// shell's own resource:// modules.  They can still be *parsed*: a SyntaxError
// is raised before any import is resolved, so a failure to resolve a shell
// module means the file itself was accepted.  That is worth knowing, because a
// construct SpiderMonkey rejects reaches users as an extension that silently
// refuses to enable.
for (const entryPoint of ['../../extension.js', '../../prefs.js']) {
    const name = entryPoint.replace('../../', '');
    // Assert a positive outcome rather than "not a SyntaxError": if GJS ever
    // reports module failures differently, this must fail loudly instead of
    // quietly passing on every input.
    let outcome = 'imported cleanly';
    try {
        await import(entryPoint);
    } catch (error) {
        const message = String(error?.message ?? error);
        if (error?.constructor?.name === 'SyntaxError')
            outcome = `rejected by the parser — ${message}`;
        else if (message.includes('resource:///'))
            outcome = 'parsed; failed resolving a GNOME Shell module, as expected outside the shell';
        else
            outcome = `unrecognised failure (${error?.constructor?.name}) — ${message}`;
    }
    equal(`${name} is accepted by the GJS parser`,
        outcome === 'imported cleanly' || outcome.startsWith('parsed;'), true);
    print(`#   ${name}: ${outcome}`);
}

// The harness's own status line, which is the only thing telling a reader
// whether a passing report is evidence about the oldest shell this extension
// claims or about something newer. `System.version` is packed as
// major * 10000 + minor * 100 + micro.
equal('gjs 1.78.5 is below the floor', standingAgainstFloor(1_78_05), 'below the floor');
equal('gjs 1.80.0 is the floor', standingAgainstFloor(1_80_00), 'the floor itself');
equal('gjs 1.80.2 is still the floor', standingAgainstFloor(1_80_02), 'the floor itself');
equal('gjs 1.82.0 is ahead of it', standingAgainstFloor(1_82_00), 'ahead of the floor');

finish('gjs stack');
