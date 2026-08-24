// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The GSettings schema is the enforcing authority for every setting's range,
// and prefs.js repeats those ranges so the spin buttons can honour them. That
// duplication carried a comment saying the two were kept in step and nothing
// that checked it — a drift would have given the user a control that silently
// refused part of its own range.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const schema = read('schemas/org.gnome.shell.extensions.thermal-throttle-monitor.gschema.xml');
const prefs = read('prefs.js');
const metadata = JSON.parse(read('metadata.json'));

/** @returns {{type: string, default: string, min?: string, max?: string}} */
function key(name) {
    const block = schema.match(new RegExp(`<key name="${name}"[^>]*>(.*?)</key>`, 's'));
    assert.ok(block, `schema declares ${name}`);
    const of = pattern => block[1].match(pattern)?.[1];
    return {
        type: schema.match(new RegExp(`<key name="${name}" type="(\\w+)"`))[1],
        default: of(/<default>(.*?)<\/default>/),
        min: of(/<range min="(-?\d+)"/),
        max: of(/<range[^>]*max="(-?\d+)"/),
    };
}

test('every settings key declares a default', () => {
    for (const name of ['temp-warn', 'temp-crit', 'poll-interval',
        'hide-when-nominal', 'notify-on-throttle'])
        assert.ok(key(name).default, `${name} has a default`);
});

test('every numeric key is bounded', () => {
    for (const name of ['temp-warn', 'temp-crit', 'poll-interval']) {
        const {min, max} = key(name);
        assert.ok(min && max, `${name} declares a range`);
        assert.ok(Number(min) < Number(max), `${name} range is ordered`);
    }
});

test('each default sits inside its own range', () => {
    for (const name of ['temp-warn', 'temp-crit', 'poll-interval']) {
        const {default: value, min, max} = key(name);
        assert.ok(Number(value) >= Number(min) && Number(value) <= Number(max),
            `${name} default ${value} is within ${min}–${max}`);
    }
});

test('the warning default is below the critical default', () => {
    assert.ok(Number(key('temp-warn').default) < Number(key('temp-crit').default));
});

test('prefs.js offers exactly the range the schema enforces', () => {
    // A spin button wider than the schema silently refuses values it displays;
    // a narrower one hides values the schema would accept.
    const constant = name => Number(prefs.match(new RegExp(`${name} = (\\d+)`))[1]);
    assert.equal(constant('TEMP_MIN'), Number(key('temp-warn').min));
    assert.equal(constant('TEMP_MAX'), Number(key('temp-warn').max));
    assert.equal(constant('TEMP_MIN'), Number(key('temp-crit').min));
    assert.equal(constant('TEMP_MAX'), Number(key('temp-crit').max));
    assert.equal(constant('POLL_MIN'), Number(key('poll-interval').min));
    assert.equal(constant('POLL_MAX'), Number(key('poll-interval').max));
});

test('metadata points at the schema that is actually shipped', () => {
    const id = schema.match(/<schema id="([^"]+)"/)[1];
    assert.equal(metadata['settings-schema'], id);
});

test('the extension version is an integer, as extensions.gnome.org requires', () => {
    assert.ok(Number.isInteger(metadata.version), 'version is an integer');
    assert.ok(metadata.version > 0);
});

test('the temperature range spans the hardware it is compared against', () => {
    // TjMax runs to 125 °C in coretemp's own table. A range that stopped below
    // that would leave a user on such a part unable to set a threshold their
    // CPU can actually reach — and unable to set one it cannot, which is how
    // the preference is switched off in favour of the throttle point alone.
    const HIGHEST_TJMAX_C = 125;
    for (const name of ['temp-warn', 'temp-crit'])
        assert.ok(Number(key(name).max) >= HIGHEST_TJMAX_C,
            `${name} tops out at ${key(name).max}, below TjMax ${HIGHEST_TJMAX_C}`);
});
