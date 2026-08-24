// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Every string the user can see, and the CSS contract the stylesheet answers to.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {Confidence} from '../src/domain/confidence.js';
import {
    BADGES, STYLE_CLASSES, badgeFor, componentLines, panelAccessibleName,
    panelLabel, sectionTitle, styleClassFor, throttleNotification, truncate,
} from '../src/presentation.js';

const ALL_LEVELS = Object.values(Confidence);
const snapshot = (over = {}) =>
    ({level: Confidence.LOW, temperatureC: 72, throttlingCount: null, ...over});

test('every level has a badge and a style class', () => {
    for (const level of ALL_LEVELS) {
        assert.ok(BADGES[level]?.length > 0, `badge for ${level}`);
        assert.match(STYLE_CLASSES[level], /^ttm-/, `class for ${level}`);
    }
    assert.equal(Object.keys(BADGES).length, ALL_LEVELS.length);
    assert.equal(new Set(Object.values(STYLE_CLASSES)).size, ALL_LEVELS.length);
});

test('the badge ramp reads as a confidence scale without relying on colour', () => {
    const filled = level => (BADGES[level].match(/█/g) ?? []).length;
    assert.deepEqual(
        [Confidence.CONFIRMED, Confidence.HIGH, Confidence.MEDIUM, Confidence.LOW, Confidence.IDLE]
            .map(filled),
        [4, 3, 2, 1, 0]);
});

test('an unrecognised level degrades to the unknown presentation', () => {
    assert.equal(badgeFor('nonsense'), BADGES[Confidence.UNKNOWN]);
    assert.equal(styleClassFor('nonsense'), STYLE_CLASSES[Confidence.UNKNOWN]);
});

test('the stylesheet defines every class the presentation can emit', () => {
    const stylesheet = readFileSync(new URL('../stylesheet.css', import.meta.url), 'utf8');
    for (const className of Object.values(STYLE_CLASSES))
        assert.match(stylesheet, new RegExp(`\\.${className}\\b`), `${className} is styled`);
});

test('the panel label shows the state glyph, the temperature and the core count', () => {
    assert.equal(panelLabel(snapshot()), '● 72°C');
    assert.equal(panelLabel(snapshot({level: Confidence.CONFIRMED, temperatureC: 92, throttlingCount: 3})),
        '⚠ 92°C (3)');
});

test('the alert glyph marks exactly the levels worth looking at', () => {
    const alerting = ALL_LEVELS.filter(level => panelLabel(snapshot({level})).startsWith('⚠'));
    assert.deepEqual(alerting.sort(), ['confirmed', 'high']);
});

test('a missing temperature is shown as unknown, not as zero', () => {
    assert.equal(panelLabel(snapshot({temperatureC: null})), '● ?°C');
    assert.equal(panelLabel(snapshot({temperatureC: 0})), '● 0°C');
});

test('the accessible name speaks the state that the glyph and colour show', () => {
    assert.equal(panelAccessibleName(snapshot({level: Confidence.CONFIRMED, temperatureC: 92})),
        'Thermal throttle monitor: throttling, CPU 92 degrees Celsius');
    assert.equal(panelAccessibleName(snapshot({level: Confidence.UNKNOWN, temperatureC: null})),
        'Thermal throttle monitor: no sensor data');
});

// The panel writes the core count as "(3)", which a screen reader announces as
// a bare number in brackets — or as nothing at all. A sighted user should not be
// the only one who learns how much of the CPU is throttling.
// A VM or a container has no coretemp, no DRM node and no accel device at all.
// "?°C" there claims a temperature somewhere that could not be read — a sentence
// about hardware that is not present, from an extension whose whole premise is
// not saying more than it knows.
test('a machine with no supported hardware is not reported as an unread sensor', () => {
    const empty = snapshot({level: Confidence.UNKNOWN, temperatureC: null, components: []});
    assert.equal(panelLabel(empty), '● —');
    assert.doesNotMatch(panelLabel(empty), /\?/, 'a question mark implies a sensor');
    assert.equal(panelAccessibleName(empty),
        'Thermal throttle monitor: no supported hardware found');
});

test('a component that exists but cannot be read still reports as unread', () => {
    // The other half of the distinction: here there *is* a sensor, and "?°C" is
    // exactly right.
    const unreadable = snapshot({
        level: Confidence.UNKNOWN,
        temperatureC: null,
        components: [{id: 'cpu:intel', title: 'CPU', level: Confidence.UNKNOWN,
            summary: 'No data', detail: 'Temperature unreadable'}],
    });
    assert.equal(panelLabel(unreadable), '● ?°C');
    assert.match(panelAccessibleName(unreadable), /no sensor data$/);
});

test('a snapshot with no components field is left alone', () => {
    // Every real Snapshot carries one; a caller passing a bare level should get
    // the ordinary rendering rather than the empty-machine one.
    assert.equal(panelLabel({level: Confidence.LOW, temperatureC: 72}), '● 72°C');
});

test('the throttling core count is spoken, not just shown', () => {
    const spoken = panelAccessibleName(
        snapshot({level: Confidence.CONFIRMED, temperatureC: 92, throttlingCount: 3}));
    assert.equal(spoken,
        'Thermal throttle monitor: throttling, CPU 92 degrees Celsius, 3 cores throttling');
    assert.doesNotMatch(spoken, /\(/, 'brackets are a visual device');
});

test('one throttling core is spoken in the singular', () => {
    assert.match(
        panelAccessibleName(snapshot({level: Confidence.CONFIRMED, throttlingCount: 1})),
        /, 1 core throttling$/);
});

test('no count is spoken when nothing reports one', () => {
    for (const count of [null, undefined, 0])
        assert.doesNotMatch(
            panelAccessibleName(snapshot({throttlingCount: count})), /core/,
            `for ${String(count)}`);
});

test('the panel label shows a count only when there is one', () => {
    for (const count of [null, undefined, 0])
        assert.equal(panelLabel(snapshot({temperatureC: 72, throttlingCount: count})), '● 72°C',
            `for ${String(count)}`);
    assert.equal(
        panelLabel(snapshot({level: Confidence.CONFIRMED, temperatureC: 92, throttlingCount: 12})),
        '⚠ 92°C (12)');
});

test('every level is spoken distinctly, and none of them leaks a glyph or a CSS class', () => {
    const spoken = ALL_LEVELS.map(level => panelAccessibleName(snapshot({level})));
    for (const [i, text] of spoken.entries())
        assert.doesNotMatch(text, /[█░⚠●]|ttm-/, `for ${ALL_LEVELS[i]}`);
    assert.equal(new Set(spoken).size, ALL_LEVELS.length,
        'each level must be distinguishable by ear');
});

test('a component renders as a badged headline plus an indented detail', () => {
    const {status, detail} = componentLines(
        {level: Confidence.CONFIRMED, summary: '92°C', detail: '3 of 8 cores throttling'});
    assert.equal(status, '████ CONFIRMED   92°C');
    assert.equal(detail, '  3 of 8 cores throttling');
});

test('a component with nothing to add renders an empty detail line', () => {
    assert.equal(componentLines({level: Confidence.UNKNOWN, summary: 'No data', detail: ''}).detail, '');
});

test('a component also renders a spoken form with no badge glyphs in it', () => {
    const {spoken} = componentLines({
        level: Confidence.CONFIRMED, summary: '92°C', detail: '3 of 8 cores throttling',
    });
    assert.equal(spoken, 'throttling, 92°C, 3 of 8 cores throttling');
    assert.doesNotMatch(spoken, /[█░]/);
});

test('the spoken form omits an empty detail rather than trailing a comma', () => {
    assert.equal(componentLines({level: Confidence.IDLE, summary: 'Idle', detail: ''}).spoken,
        'idle, Idle');
});

test('every level produces a spoken component form free of badge glyphs', () => {
    for (const level of ALL_LEVELS) {
        const {spoken} = componentLines({level, summary: 'x', detail: 'y'});
        assert.doesNotMatch(spoken, /[█░⚠●]/, `for ${level}`);
        assert.ok(spoken.length > 0);
    }
});

// Some section headings are built from kernel text — the xe adapter names a GT
// after `gtidle/name` when it does not recognise the engine role — and a popup
// menu item does not wrap.
test('a section heading is passed through unchanged when it is a sane length', () => {
    assert.equal(sectionTitle('GPU — Media/Codec'), 'GPU — Media/Codec');
    assert.equal(sectionTitle('CPU'), 'CPU');
});

test('a section heading is trimmed of surrounding whitespace', () => {
    assert.equal(sectionTitle('  NPU \n'), 'NPU');
});

test('a section heading collapses whitespace it cannot render', () => {
    // A PopupMenuItem is one line. `readText` trims the ends of a kernel string
    // but leaves anything inside it, and a newline there would render as a gap
    // or a box — and would count against the length bound while being invisible.
    assert.equal(sectionTitle('GPU\nMedia'), 'GPU Media');
    assert.equal(sectionTitle('GPU\t \u00a0 Media'), 'GPU Media');
    assert.equal([...sectionTitle(`GPU ${'z\n'.repeat(200)}`)].length, 41);
});

test('an absurdly long section heading is cut to a bounded length', () => {
    // A character bound, not a pixel one — a popup menu item does not wrap, and
    // this is as much as a pure function can promise about how wide it renders.
    const heading = sectionTitle(`GPU — ${'z'.repeat(5000)}`);
    assert.equal([...heading].length, 41, 'forty characters plus the ellipsis');
    assert.match(heading, /…$/);
});

test('an empty or missing heading still names the section', () => {
    for (const input of ['', '   ', null, undefined])
        assert.equal(sectionTitle(input), 'Unknown component', `for ${String(input)}`);
});

// The README shows a worked example of the popup. It is hand-maintained prose
// next to strings this module generates, and it drifted once already — it
// showed badges padded into a column that the code does not produce.
test('the README shows the popup exactly as this module renders it', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const rows = [
        {level: Confidence.CONFIRMED, summary: '92°C', detail: '3 of 8 cores throttling — thermal (TCC)'},
        {level: Confidence.LOW, summary: 'Nominal', detail: '1900 / 2050 MHz'},
        {level: Confidence.IDLE, summary: 'Idle', detail: '700 / 1200 MHz'},
        {level: Confidence.LOW, summary: 'Active', detail: '950 / 1950 MHz (49%) — CPU 8°C from its throttle point'},
    ];

    for (const row of rows) {
        const {status, detail} = componentLines(row);
        assert.ok(readme.includes(status), `README is missing the line: ${status}`);
        assert.ok(readme.includes(detail.trimStart()), `README is missing: ${detail.trim()}`);
    }
});

// The project's whole claim is that inference is not proof. Rendering HIGH in
// the same colour as CONFIRMED gave that away at the last step.
const stylesheet = () => readFileSync(new URL('../stylesheet.css', import.meta.url), 'utf8');

// The stylesheet and the code that names its classes are two hand-maintained
// lists. A class the code emits with no rule renders as unstyled panel text and
// looks like "nothing to report"; a rule nothing emits is dead weight shipped to
// every user. Neither shows up in a test that only checks the classes it knows.
test('every class the extension emits has a rule, and every rule is emitted', () => {
    const css = stylesheet();
    const declared = new Set(
        [...css.matchAll(/^\s*\.(ttm-[\w-]+)\s*[,{]/gm)].map(match => match[1]));

    // Everything styleClassFor can return, plus the one the panel label always
    // carries, which is applied in extension.js rather than chosen per level.
    const emitted = new Set([...ALL_LEVELS.map(styleClassFor), 'ttm-label']);

    const unstyled = [...emitted].filter(name => !declared.has(name)).sort();
    assert.deepEqual(unstyled, [], `emitted with no rule: ${unstyled.join(', ')}`);

    const dead = [...declared].filter(name => !emitted.has(name)).sort();
    assert.deepEqual(dead, [], `styled but never emitted: ${dead.join(', ')}`);
});

test('the panel label class is the one extension.js actually applies', () => {
    // ttm-label is above in `emitted` on the strength of this. If the adapter
    // stops applying it, that list is quietly wrong and the check above passes
    // on a class nobody uses.
    const adapter = readFileSync(new URL('../extension.js', import.meta.url), 'utf8');
    assert.match(adapter, /style_class: 'ttm-label /);
});

test('CONFIRMED and HIGH are not the same colour', () => {
    const css = stylesheet();
    const colourOf = className => {
        const match = css.match(new RegExp(`\\.${className}\\b[^}]*?color:\\s*([^;]+);`, 's'));
        assert.ok(match, `${className} has a colour`);
        return match[1].trim();
    };
    assert.notEqual(colourOf('ttm-confirmed'), colourOf('ttm-high'));
});

test('the calm levels share one appearance, and the alert levels do not', () => {
    const css = stylesheet();
    // LOW, IDLE and UNKNOWN are all "nothing to report" and inherit the panel's
    // own colour; the three levels that mean something must be distinguishable.
    assert.match(css, /\.ttm-low,\s*\.ttm-idle,\s*\.ttm-unknown\s*\{\s*color:\s*inherit;/);
    for (const className of ['ttm-confirmed', 'ttm-high', 'ttm-medium'])
        assert.match(css, new RegExp(`\\.${className}\\s*\\{`), `${className} has its own rule`);
});

// ── Bounding kernel text ───────────────────────────────────────────────────
//
// `truncate` is what keeps a heading built from a sysfs string from stretching
// a popup menu item off the screen. It counts code points rather than UTF-16
// units, so a cut cannot land between the halves of a surrogate pair.

test('text within the limit is returned unchanged, with no marker', () => {
    assert.equal(truncate('power', 48), 'power');
    assert.equal(truncate('', 48), '');
    assert.equal(truncate('y'.repeat(48), 48), 'y'.repeat(48));
});

test('text over the limit is cut and marked', () => {
    assert.equal(truncate('z'.repeat(60), 10), `${'z'.repeat(10)}…`);
});

test('the cut never splits a surrogate pair', () => {
    // Slicing by UTF-16 unit would leave a lone high surrogate here, which
    // renders as a replacement glyph.
    const text = `${'a'.repeat(39)}😀${'b'.repeat(20)}`;
    const cut = truncate(text, 40);
    assert.ok(!/[\uD800-\uDBFF]$/.test(cut.slice(0, -1)), 'no lone high surrogate');
    assert.equal(cut, `${'a'.repeat(39)}😀…`);
});

test('the limit counts characters, not UTF-16 units', () => {
    assert.equal(truncate('😀'.repeat(10), 10), '😀'.repeat(10), 'ten characters, twenty units');
    assert.equal(truncate('😀'.repeat(11), 10), `${'😀'.repeat(10)}…`);
});

// The notification's wording lives here rather than in `extension.js` for the
// reason everything else user-visible does: that file is the one no test can
// execute. What is left there is two shell API calls.
test('the notification names the component that is throttling', () => {
    const {title, body} = throttleNotification({components: [
        {title: 'CPU', level: Confidence.LOW, summary: '70°C', detail: 'Nominal'},
        {title: 'GPU — Render', level: Confidence.CONFIRMED, summary: 'Throttled',
            detail: '1900 / 2050 MHz — PROCHOT'},
    ]});
    assert.equal(title, 'Thermal throttling detected');
    assert.equal(body, 'GPU — Render: 1900 / 2050 MHz — PROCHOT');
});

test('a component with no detail falls back to its summary', () => {
    assert.equal(throttleNotification({components: [
        {title: 'CPU', level: Confidence.CONFIRMED, summary: '92°C', detail: ''},
    ]}).body, 'CPU: 92°C');
});

// HIGH is inference; only a hardware counter is a throttle. The notification
// fires on the Monitor's confirmed edge, so anything short of it is not the
// component being reported.
test('only a confirmed component is named', () => {
    const body = throttleNotification({components: [
        {title: 'GPU', level: Confidence.HIGH, summary: 'Throttled', detail: 'thermal'},
        {title: 'CPU', level: Confidence.CONFIRMED, summary: '99°C', detail: '2 of 4 cores'},
    ]}).body;
    assert.equal(body, 'CPU: 2 of 4 cores');
});

// The heading can be built from a kernel string, and a notification body is not
// where anyone wants to discover that.
test('the component heading is bounded exactly as the popup heading is', () => {
    const title = `GPU — ${'x'.repeat(80)}`;
    const body = throttleNotification({components: [
        {title, level: Confidence.CONFIRMED, summary: 'Throttled', detail: 'PROCHOT'},
    ]}).body;
    assert.equal(body, `${sectionTitle(title)}: PROCHOT`);
    assert.ok(body.length < 60, `bounded, got ${body.length} characters`);
});

// The edge comes from the Monitor, not from this function. A snapshot that
// reports one without a confirmed component would otherwise send an empty
// banner, which says less than nothing.
test('a snapshot with nothing confirmed still produces a body', () => {
    for (const components of [[], undefined,
        [{title: 'CPU', level: Confidence.LOW, summary: '60°C', detail: ''}]])
        assert.equal(throttleNotification({components}).body,
            'A component is thermally throttling.');
});
