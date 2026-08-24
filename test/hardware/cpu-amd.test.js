// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// AMD CPU adapter.  Written from the documented k10temp sysfs layout and not
// yet validated on hardware — these tests pin the layout assumptions so a
// report from an AMD user can be turned into a failing test in one step.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import driver from '../../src/hardware/cpu-amd.js';
import {Thresholds} from '../../src/domain/thresholds.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const HWMON = '/sys/class/hwmon/hwmon3';
const k10temp = entries => filesIn(HWMON, {name: 'k10temp', ...entries});

const discoverOne = files => {
    const components = driver.discover(fakeSysfs({files}));
    assert.equal(components.length, 1, 'expected exactly one CPU component');
    return components[0];
};

// k10temp's `_crit` is the HTC trip temperature — AMD's hardware thermal
// control, the equivalent of Intel's TCC. It is hidden unless the northbridge
// advertises HTC and it is enabled, which in practice means pre-Zen parts, so
// both the present and absent cases are real machines.
test('the HTC trip temperature is read as the throttle point', () => {
    const reading = discoverOne(k10temp({
        temp1_label: 'Tctl', temp1_input: '62000', temp1_crit: '95000',
    })).read();
    assert.equal(reading.packageTempC, 62);
    assert.equal(reading.throttlePointC, 95);
});

test('a Zen part, which publishes no HTC trip, reports none', () => {
    const reading = discoverOne(k10temp({temp1_label: 'Tctl', temp1_input: '62000'})).read();
    assert.equal(reading.packageTempC, 62);
    assert.equal(reading.throttlePointC, null);
});

test('the first channel carrying a label wins, deterministically', () => {
    // sysfs listings are naturally ordered, so "first" means temp1 before
    // temp2. Letting a later duplicate overwrite it would make which sensor is
    // read depend on directory order, and these are separate sensors with
    // separate trip points.
    const reading = discoverOne(k10temp({
        temp1_label: 'Tctl', temp1_input: '62000', temp1_crit: '95000',
        temp2_label: 'Tctl', temp2_input: '71000', temp2_crit: '80000',
    })).read();
    assert.deepEqual([reading.packageTempC, reading.throttlePointC], [62, 95]);
});

test('the trip point follows the sensor that was preferred', () => {
    // Tctl wins over Tdie, and its own channel's _crit must come with it.
    const reading = discoverOne(k10temp({
        temp1_label: 'Tdie', temp1_input: '60000', temp1_crit: '90000',
        temp2_label: 'Tctl', temp2_input: '62000', temp2_crit: '95000',
    })).read();
    assert.deepEqual([reading.packageTempC, reading.throttlePointC], [62, 95]);
});

test('temp1_max is not mistaken for a trip point', () => {
    // k10temp hard-codes _max to 70 °C. It is a target, not the temperature at
    // which anything throttles, and reading it as one would report a laptop as
    // past its throttle point at any load at all.
    const reading = discoverOne(k10temp({
        temp1_label: 'Tctl', temp1_input: '75000', temp1_max: '70000',
    })).read();
    assert.equal(reading.throttlePointC, null);
});

test('no k10temp means no component', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
    assert.deepEqual(driver.discover(fakeSysfs({files: filesIn('/sys/class/hwmon/hwmon0', {
        name: 'nvme', temp1_label: 'Tctl', temp1_input: '40000',
    })})), [], 'the label alone must not match');
});

test('a discovered CPU has a stable identity and offers its temperature', () => {
    const component = discoverOne(k10temp({temp1_label: 'Tctl', temp1_input: '61000'}));
    assert.equal(component.id, 'cpu:amd');
    assert.equal(component.title, 'CPU');
    assert.equal(component.temperatureC(component.read()), 61);
});

test('Tctl is preferred, because it is what the platform throttles against', () => {
    const component = discoverOne(k10temp({
        temp1_label: 'Tdie', temp1_input: '50000',
        temp2_label: 'Tctl', temp2_input: '70000',
        temp3_label: 'Tccd1', temp3_input: '90000',
    }));
    assert.equal(component.read().packageTempC, 70);
});

test('Tdie is the second choice', () => {
    const component = discoverOne(k10temp({
        temp1_label: 'Tccd1', temp1_input: '90000',
        temp2_label: 'Tdie', temp2_input: '55000',
    }));
    assert.equal(component.read().packageTempC, 55);
});

test('with neither preferred label, the first readable input is used', () => {
    const component = discoverOne(k10temp({
        temp2_label: 'Tccd1', temp2_input: '48000',
        temp3_label: 'Tccd2', temp3_input: '99000',
    }));
    assert.equal(component.read().packageTempC, 48);
});

test('a k10temp with no labels at all falls back to temp1_input', () => {
    assert.equal(discoverOne(k10temp({temp1_input: '44000'})).read().packageTempC, 44);
});

test('a labelled input that cannot be read is not selected', () => {
    const files = k10temp({
        temp1_label: 'Tctl', temp1_input: '70000',
        temp2_label: 'Tdie', temp2_input: '55000',
    });
    const sysfs = fakeSysfs({files, unreadable: [`${HWMON}/temp1_input`]});
    assert.equal(driver.discover(sysfs)[0].read().packageTempC, 55);
});

test('a k10temp exposing no usable input at all yields no component', () => {
    assert.deepEqual(driver.discover(fakeSysfs({files: k10temp({temp1_label: 'Tctl'})})), []);
});

// The honesty guarantee: AMD publishes no per-core throttle counter at all, so
// the shared CPU rule must be structurally unable to reach CONFIRMED here.
test('the reading carries no per-core counters, so CONFIRMED is unreachable', () => {
    const component = discoverOne(k10temp({temp1_label: 'Tctl', temp1_input: '99000'}));
    const reading = component.read();
    assert.deepEqual(reading.cores, []);

    const context = {packageTempC: 99, thresholds: new Thresholds(88, 94)};
    assert.equal(component.assess(reading, reading, context).level, Confidence.HIGH);
});

// Verified against `k10temp_is_visible()`: `_crit` is hidden on any non-zero
// channel, and `tempN_label` is shown "only on Zen CPUs". So the two machines
// this adapter meets are exact opposites, and the unlabelled fallback is the
// one with a trip point rather than the degenerate case it looks like.
test('a pre-Zen part has a trip point and no labels; a Zen part is the reverse', () => {
    const preZen = discoverOne(k10temp({temp1_input: '62000', temp1_crit: '95000'})).read();
    assert.deepEqual([preZen.packageTempC, preZen.throttlePointC], [62, 95]);

    const zen = discoverOne(k10temp({
        temp1_label: 'Tctl', temp1_input: '62000',
        temp2_label: 'Tdie', temp2_input: '61000',
        temp3_label: 'Tccd1', temp3_input: '90000',
    })).read();
    assert.deepEqual([zen.packageTempC, zen.throttlePointC], [62, null]);
});

// The Intel adapter reads per-core channels; this one does not, and the reason
// is in the driver rather than in a preference. `k10temp_info[]` gives every
// `Tccd*` channel INPUT | LABEL and nothing else, so a per-die temperature
// arrives with no trip point to measure it against — and this project has
// nothing to say about a temperature on its own.
test('the per-die channels are not offered to the rule', () => {
    const reading = discoverOne(k10temp({
        temp1_label: 'Tctl', temp1_input: '62000',
        temp2_label: 'Tccd1', temp2_input: '90000',
        temp3_label: 'Tccd2', temp3_input: '91000',
    })).read();
    assert.equal(reading.coreTemps, undefined);
});
