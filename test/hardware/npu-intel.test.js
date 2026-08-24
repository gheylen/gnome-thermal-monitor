// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';

import driver from '../../src/hardware/npu-intel.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const npu = (accel, entries) => filesIn(`/sys/class/accel/${accel}/device`, {
    npu_current_frequency_mhz: 950,
    npu_max_frequency_mhz: 1950,
    npu_busy_time_us: 123456,
    ...entries,
});

test('no accel class means no component', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
});

test('an accel device without the npu attributes is not an NPU', () => {
    assert.deepEqual(driver.discover(fakeSysfs({files: filesIn('/sys/class/accel/accel0/device', {
        vendor: '0x8086',
    })})), []);
});

test('a discovered NPU has a stable identity', () => {
    const [component] = driver.discover(fakeSysfs({files: npu('accel0')}));
    assert.equal(component.id, 'npu:intel');
    assert.equal(component.title, 'NPU');
    assert.equal(component.temperatureC, undefined, 'the NPU exposes no temperature');
});

test('the reading carries frequency and busy time', () => {
    const [component] = driver.discover(fakeSysfs({files: npu('accel0')}));
    assert.deepEqual(component.read(),
        {currentMhz: 950, maxMhz: 1950, hardwareMaxMhz: 1950, busyUs: 123456});
});

test('an accel device that is not an NPU is skipped in favour of one that is', () => {
    const [component] = driver.discover(fakeSysfs({files: {
        ...filesIn('/sys/class/accel/accel0/device', {vendor: '0x8086'}),
        ...npu('accel1', {npu_current_frequency_mhz: 700}),
    }}));
    assert.equal(component.read().currentMhz, 700);
});

test('missing companion attributes read as null rather than as zero', () => {
    const files = npu('accel0');
    delete files['/sys/class/accel/accel0/device/npu_max_frequency_mhz'];
    delete files['/sys/class/accel/accel0/device/npu_busy_time_us'];
    assert.deepEqual(driver.discover(fakeSysfs({files}))[0].read(),
        {currentMhz: 950, maxMhz: null, hardwareMaxMhz: null, busyUs: null});
});

// `ivpu_sysfs.c` adds `freq/set_max_freq` to the group only for
// `ivpu_hw_ip_gen(vdev) >= IVPU_HW_IP_50XX`, so Meteor Lake and Lunar Lake have
// the hardware ceiling and nothing else. That is the fixture above.
test('a configured ceiling is what the NPU is measured against', () => {
    const files = {
        ...npu('accel0'),
        '/sys/class/accel/accel0/device/freq/set_max_freq': '1000',
    };
    assert.deepEqual(driver.discover(fakeSysfs({files}))[0].read(),
        {currentMhz: 950, maxMhz: 1000, hardwareMaxMhz: 1950, busyUs: 123456});
});

test('a configured ceiling equal to the hardware one is not a cap', () => {
    const files = {
        ...npu('accel0'),
        '/sys/class/accel/accel0/device/freq/set_max_freq': '1950',
    };
    const reading = driver.discover(fakeSysfs({files}))[0].read();
    assert.deepEqual([reading.maxMhz, reading.hardwareMaxMhz], [1950, 1950]);
});

test('an unreadable configured ceiling falls back to the hardware one', () => {
    for (const contents of ['', 'nonsense', '0']) {
        const files = {
            ...npu('accel0'),
            '/sys/class/accel/accel0/device/freq/set_max_freq': contents,
        };
        assert.equal(driver.discover(fakeSysfs({files}))[0].read().maxMhz, 1950,
            `for ${JSON.stringify(contents)}`);
    }
});

test('only one NPU component is produced even with several accel devices', () => {
    const components = driver.discover(fakeSysfs({files: {...npu('accel0'), ...npu('accel1')}}));
    assert.equal(components.length, 1);
});
