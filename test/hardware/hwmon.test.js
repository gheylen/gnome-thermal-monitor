// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The hwmon layout, shared by every adapter that reads a temperature. Both CPU
// backends had their own copy of this until the second one needed a trip point
// too, and two copies of a unit conversion is how a reading comes to be rounded
// in one place and truncated in another.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {degreesAt, devicesNamed, temperatureChannels} from '../../src/hardware/hwmon.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const HWMON = '/sys/class/hwmon';

test('devices are found by their driver name, not their number', () => {
    // hwmonN numbering is allocation order: which number coretemp gets depends
    // on what else probed first, so it is never the thing to match on.
    const sysfs = fakeSysfs({files: {
        ...filesIn(`${HWMON}/hwmon0`, {name: 'nvme', temp1_input: '40000'}),
        ...filesIn(`${HWMON}/hwmon5`, {name: 'coretemp', temp1_input: '55000'}),
    }});
    assert.deepEqual(devicesNamed(sysfs, 'coretemp'), [`${HWMON}/hwmon5`]);
    assert.deepEqual(devicesNamed(sysfs, 'k10temp'), []);
    assert.deepEqual(devicesNamed(sysfs, 'nvme'), [`${HWMON}/hwmon0`]);
});

test('two devices of the same name are both returned, in natural order', () => {
    // A name is not unique — a machine can carry two of the same chip — so a
    // caller takes the first that satisfies it rather than assuming there is one.
    const sysfs = fakeSysfs({files: {
        ...filesIn(`${HWMON}/hwmon10`, {name: 'coretemp'}),
        ...filesIn(`${HWMON}/hwmon2`, {name: 'coretemp'}),
    }});
    assert.deepEqual(devicesNamed(sysfs, 'coretemp'),
        [`${HWMON}/hwmon2`, `${HWMON}/hwmon10`], 'hwmon2 before hwmon10');
});

test('no hwmon class at all is not an error', () => {
    assert.deepEqual(devicesNamed(fakeSysfs(), 'coretemp'), []);
});

test('a device with no name attribute matches nothing', () => {
    const sysfs = fakeSysfs({files: filesIn(`${HWMON}/hwmon0`, {temp1_input: '1'})});
    assert.deepEqual(devicesNamed(sysfs, 'coretemp'), []);
});

test('channels are returned as the prefix their attributes share', () => {
    // Not one attribute: the useful ones come in sets, and pairing an _input
    // from one channel with a _crit from another describes no hardware.
    const sysfs = fakeSysfs({files: filesIn(`${HWMON}/hwmon2`, {
        name: 'coretemp',
        temp1_label: 'Package id 0', temp1_input: '55000', temp1_crit: '100000',
        temp2_label: 'Core 0', temp2_input: '50000', temp2_crit: '100000',
    })});
    assert.deepEqual(temperatureChannels(sysfs, `${HWMON}/hwmon2`), [
        {label: 'Package id 0', channel: `${HWMON}/hwmon2/temp1`},
        {label: 'Core 0', channel: `${HWMON}/hwmon2/temp2`},
    ]);
});

test('channels come back in natural order', () => {
    const sysfs = fakeSysfs({files: filesIn(`${HWMON}/hwmon2`, {
        temp10_label: 'Core 8', temp2_label: 'Core 0',
    })});
    assert.deepEqual(temperatureChannels(sysfs, `${HWMON}/hwmon2`).map(c => c.label),
        ['Core 0', 'Core 8']);
});

test('an unreadable label still yields its channel', () => {
    // The attributes beside it are the point; a caller that wanted the label
    // can see it is null and skip.
    const sysfs = fakeSysfs({
        files: filesIn(`${HWMON}/hwmon2`, {temp1_label: 'Tctl', temp1_input: '1'}),
        unreadable: [`${HWMON}/hwmon2/temp1_label`],
    });
    assert.deepEqual(temperatureChannels(sysfs, `${HWMON}/hwmon2`),
        [{label: null, channel: `${HWMON}/hwmon2/temp1`}]);
});

test('a device with no labelled channels yields none', () => {
    const sysfs = fakeSysfs({files: filesIn(`${HWMON}/hwmon2`, {name: 'k10temp', temp1_input: '1'})});
    assert.deepEqual(temperatureChannels(sysfs, `${HWMON}/hwmon2`), []);
});

test('millidegrees become whole degrees, rounded', () => {
    const sysfs = fakeSysfs({files: filesIn(`${HWMON}/hwmon2`, {
        a: '94999', b: '55000', c: '55499', d: '-40000', e: '0',
    })});
    const at = name => degreesAt(sysfs, `${HWMON}/hwmon2/${name}`);
    assert.equal(at('a'), 95, 'truncating would put a machine a degree cooler than it is');
    assert.equal(at('b'), 55);
    assert.equal(at('c'), 55);
    assert.equal(at('d'), -40);
    assert.equal(at('e'), 0);
});

test('a null path is answered without touching the port at all', () => {
    // Not merely null-safe by accident: the port must not be handed a null path
    // and left to fail on it. "Nothing in the read path may throw" is easier to
    // keep when nothing relies on a throw being caught — and under the real Gio
    // adapter, `Gio.File.new_for_path(null)` is exactly such a reliance.
    const read = [];
    const sysfs = fakeSysfs({files: {}, onRead: path => read.push(path)});
    assert.equal(degreesAt(sysfs, null), null);
    assert.deepEqual(read, []);
});

test('an absent, unreadable or malformed attribute is null, never zero', () => {
    const sysfs = fakeSysfs({
        files: filesIn(`${HWMON}/hwmon2`, {text: 'none', blocked: '1000'}),
        unreadable: [`${HWMON}/hwmon2/blocked`],
    });
    for (const path of [null, `${HWMON}/hwmon2/absent`, `${HWMON}/hwmon2/text`,
        `${HWMON}/hwmon2/blocked`])
        assert.equal(degreesAt(sysfs, path), null, `for ${String(path)}`);
});
