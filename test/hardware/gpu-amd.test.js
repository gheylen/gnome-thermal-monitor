// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// AMD GPU adapter, against the layout `amdgpu_pm.c` documents.
//
// Written from the driver's own interface documentation and its
// `SENSOR_DEVICE_ATTR` table, not from the adapter — the lesson this repository
// learned from an i915 backend that looked for its attributes in a directory
// i915 does not use, and whose eight tests all passed.
//
// Nobody has run this on an AMD card. Every assumption it makes is pinned here,
// so a report from someone who has can be turned into a failing test in one
// step.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import driver from '../../src/hardware/gpu-amd.js';
import {Thresholds} from '../../src/domain/thresholds.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const HWMON = '/sys/class/hwmon/hwmon5';
const THRESHOLDS = new Thresholds(88, 94);
const context = {packageTempC: null, packageThrottlePointC: null, thresholds: THRESHOLDS};
/** Thresholds out of the way, so a case is the hardware's statement alone. */
const quiet = {...context, thresholds: new Thresholds(120, 125)};

/**
 * A card as `amdgpu_pm.c` describes it: `temp_label[]` is edge, junction, mem,
 * and only channel 1 exists before SOC15.
 */
const card = ({
    device = HWMON, edge = 61_000, edgeCrit = 100_000,
    junction = null, junctionCrit = 110_000,
    mem = null, memCrit = 105_000, sclkHz = 1_800_000_000,
} = {}) => {
    const files = filesIn(device, {
        name: 'amdgpu',
        temp1_label: 'edge', temp1_input: edge, temp1_crit: edgeCrit,
        // Read by nothing: the ASIC shutdown point is not a throttle point.
        temp1_emergency: '105000',
    });
    if (junction !== null)
        Object.assign(files, filesIn(device, {
            temp2_label: 'junction', temp2_input: junction, temp2_crit: junctionCrit,
        }));
    if (mem !== null)
        Object.assign(files, filesIn(device, {
            temp3_label: 'mem', temp3_input: mem, temp3_crit: memCrit,
        }));
    if (sclkHz !== null)
        Object.assign(files, filesIn(device, {freq1_label: 'sclk', freq1_input: sclkHz}));
    return files;
};

const discoverOne = files => driver.discover(fakeSysfs({files}))[0];

test('no amdgpu hwmon means no component', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
    assert.deepEqual(driver.discover(fakeSysfs({files: filesIn(HWMON, {
        name: 'k10temp', temp1_label: 'Tctl', temp1_input: '60000',
    })})), [], 'another driver\'s hwmon is not ours');
});

test('a discovered card has a stable identity', () => {
    const component = discoverOne(card());
    assert.equal(component.id, 'gpu:amdgpu:0');
    assert.equal(component.title, 'GPU — AMD');
    assert.equal(component.temperatureC, undefined,
        'the panel temperature slot belongs to the CPU');
});

// `amdgpu_hwmon_show_sclk` emits `sclk * 10 * 1000`, which is hertz.
test('the gfx clock is read in hertz and reported in megahertz', () => {
    assert.equal(discoverOne(card({sclkHz: 1_800_000_000})).read().currentMhz, 1800);
    assert.equal(discoverOne(card({sclkHz: 2_450_000_000})).read().currentMhz, 2450);
});

test('a card publishing no clock reports none rather than zero', () => {
    const reading = discoverOne(card({sclkHz: null})).read();
    assert.equal(reading.currentMhz, null);
});

test('every published channel becomes a sensor with its own trip point', () => {
    const reading = discoverOne(card({
        edge: 61_000, edgeCrit: 100_000,
        junction: 88_000, junctionCrit: 110_000,
        mem: 74_000, memCrit: 105_000,
    })).read();

    assert.deepEqual(reading.sensors, [
        {label: 'edge', tempC: 61, throttlePointC: 100, targetC: null},
        {label: 'junction', tempC: 88, throttlePointC: 110, targetC: null},
        {label: 'mem', tempC: 74, throttlePointC: 105, targetC: null},
    ]);
});

// `amdgpu_hwmon_is_visible()` hides the junction and memory attributes on parts
// without those sensors; a pre-SOC15 card publishes channel 1 alone.
test('a card with only an edge sensor produces only that one', () => {
    const reading = discoverOne(card()).read();
    assert.deepEqual(reading.sensors.map(s => s.label), ['edge']);
});

test('a labelled channel with no readable input is not a sensor', () => {
    // A label with nothing behind it would be a section reporting "no data"
    // for ever.
    const files = card();
    files[`${HWMON}/temp2_label`] = 'junction';
    assert.deepEqual(discoverOne(files).read().sensors.map(s => s.label), ['edge']);
});

test('two cards get distinct ids and distinguishable titles', () => {
    const components = driver.discover(fakeSysfs({files: {
        ...card({device: '/sys/class/hwmon/hwmon5'}),
        ...card({device: '/sys/class/hwmon/hwmon6'}),
    }}));
    assert.deepEqual(components.map(c => [c.id, c.title]), [
        ['gpu:amdgpu:0', 'GPU — AMD 0'],
        ['gpu:amdgpu:1', 'GPU — AMD 1'],
    ]);
});

// The ASIC shutdown point is a different event from throttling, and a popup with
// room for one trip point must show the one it throttles at.
test('the emergency threshold is not mistaken for a trip point', () => {
    const reading = discoverOne(card({edgeCrit: 100_000})).read();
    assert.equal(reading.sensors[0].throttlePointC, 100);
});

test('the hottest channel relative to its own trip point is what answers', () => {
    // junction is hotter in absolute terms; edge is closer to its own limit.
    const component = discoverOne(card({
        edge: 96_000, edgeCrit: 100_000,
        junction: 99_000, junctionCrit: 110_000,
    }));
    const verdict = component.assess(component.read(), null, quiet);
    assert.equal(verdict.summary, '96°C');
    assert.match(verdict.detail, /^edge at 96°C, 4°C below its throttle point \(100°C\)/);
    assert.equal(verdict.level, Confidence.MEDIUM);
});

// Unlike the CPU, a GPU section has no number on the panel for a threshold to
// be a statement about — so it is compared against the channel the section is
// already showing, which is the one that answered.
test('the user thresholds apply to the channel this section reports', () => {
    const component = discoverOne(card({edge: 90_000, edgeCrit: 130_000}));

    assert.equal(component.assess(component.read(), null, quiet).level, Confidence.LOW,
        '40°C of headroom is nothing the hardware is worried about');
    assert.equal(component.assess(component.read(), null, context).level, Confidence.MEDIUM,
        'but the user asked to be told at 88°C');
});

test('a card at its trip point is HIGH, and never more', () => {
    const component = discoverOne(card({edge: 101_000, edgeCrit: 100_000}));
    const verdict = component.assess(component.read(), null, quiet);
    assert.equal(verdict.level, Confidence.HIGH,
        'amdgpu publishes no counter, so CONFIRMED is structurally unreachable');
    assert.match(verdict.detail, /edge at its throttle point \(100°C\)/);
});

test('the clock is reported beside the headroom, never judged', () => {
    const component = discoverOne(card({edge: 61_000, sclkHz: 500_000_000}));
    const verdict = component.assess(component.read(), null, quiet);
    assert.equal(verdict.detail,
        'edge at 61°C, 39°C below its throttle point (100°C) — 500 MHz');
    assert.equal(verdict.level, Confidence.LOW,
        'a low clock is not evidence of anything without a ceiling to compare it to');
});

test('a card whose sensors all fail reports no data, not a guess', () => {
    const files = card();
    delete files[`${HWMON}/temp1_crit`];
    const component = discoverOne(files);
    const verdict = component.assess(component.read(), null, context);
    assert.equal(verdict.level, Confidence.UNKNOWN);
    assert.equal(verdict.detail, '1800 MHz', 'what did read is still shown');
});
