// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel Xe GPU adapter, against a described Lunar Lake-style device.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import driver from '../../src/hardware/gpu-xe.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const DEVICE = '/sys/bus/pci/devices/0000:00:02.0';

/** One GT's worth of sysfs: frequency nodes, idle state, throttle registers. */
function gt(path, {
    role = 'gt0-rc', act = 1500, cur = 1500, max = 2000, rp0 = 2000,
    idle = 'gt-c0', status = 0, thermal = 0, prochot = 0, reasons = null,
} = {}) {
    return {
        ...filesIn(`${path}/freq0`, {
            act_freq: act, cur_freq: cur, max_freq: max, rp0_freq: rp0, rpn_freq: 300,
        }),
        ...filesIn(`${path}/freq0/throttle`, reasons ?? {
            status, reason_thermal: thermal, reason_prochot: prochot,
        }),
        ...filesIn(`${path}/gtidle`, {name: role, idle_status: idle}),
    };
}

/**
 * Every PCI device the driver model knows about carries `power/runtime_status`;
 * the adapter reads it before anything xe publishes, so a fixture without it
 * would be describing a machine that does not exist.
 */
const powered = (device = DEVICE, state = 'active') =>
    ({[`${device}/power/runtime_status`]: state});

const machine = (files, {driverName = 'xe', runtimeStatus = 'active'} = {}) => fakeSysfs({
    files: {...powered(DEVICE, runtimeStatus), ...files},
    links: {[`${DEVICE}/driver`]: `../../../bus/pci/drivers/${driverName}`},
});

test('no xe device means no components', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
    assert.deepEqual(
        driver.discover(machine(gt(`${DEVICE}/tile0/gt0`), {driverName: 'i915'})), [],
        'a device bound to another driver is not ours');
});

test('each GT becomes its own component, named after its engine role', () => {
    const components = driver.discover(machine({
        ...gt(`${DEVICE}/tile0/gt0`, {role: 'gt0-rc'}),
        ...gt(`${DEVICE}/tile0/gt1`, {role: 'gt1-mc'}),
    }));
    assert.deepEqual(components.map(c => [c.id, c.title]), [
        ['gpu:xe:0', 'GPU — Render'],
        ['gpu:xe:1', 'GPU — Media/Codec'],
    ]);
});

test('an unrecognised engine role is passed through rather than invented', () => {
    const [component] = driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {role: 'gt0-xx'})));
    assert.equal(component.title, 'GPU — gt0-xx');
});

test('a missing role node falls back to the GT directory name', () => {
    const files = gt(`${DEVICE}/tile0/gt3`);
    delete files[`${DEVICE}/tile0/gt3/gtidle/name`];
    assert.equal(driver.discover(machine(files))[0].title, 'GPU — gt3');
});

test('a GT with no RP0 has no yardstick and is skipped', () => {
    const files = gt(`${DEVICE}/tile0/gt0`);
    delete files[`${DEVICE}/tile0/gt0/freq0/rp0_freq`];
    assert.deepEqual(driver.discover(machine(files)), []);
});

test('GTs across multiple tiles are all found, in natural order', () => {
    const components = driver.discover(machine({
        ...gt(`${DEVICE}/tile0/gt0`, {role: 'a'}),
        ...gt(`${DEVICE}/tile1/gt0`, {role: 'b'}),
        ...gt(`${DEVICE}/tile10/gt0`, {role: 'c'}),
    }));
    assert.deepEqual(components.map(c => c.title),
        ['GPU — a', 'GPU — b', 'GPU — c']);
});

test('a reading carries the frequency shape and the throttle registers', () => {
    const [component] = driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {
        cur: 1200, max: 1600, rp0: 2100, status: 1, thermal: 1, prochot: 0,
    })));
    assert.deepEqual(component.read(), {
        currentMhz: 1200, maxMhz: 1600, rp0Mhz: 2100, idle: false,
        throttled: 1, thermalReason: 'thermal', prochot: 0,
    });
});

// `xe_gt_throttle.c` picks the attribute group per platform: `cri_throttle_attrs`
// (XE_CRESCENTISLAND) publishes no `reason_thermal` and no `reason_vr_thermalert`
// at all, offering `reason_soc_thermal`, `reason_soc_avg_thermal`,
// `reason_mem_thermal` and `reason_vr_thermal` instead. Reading the whole table
// is what lets one adapter answer on both without parsing the `reasons` string.
test('a platform without reason_thermal still reports the limit it does publish', () => {
    const [component] = driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {
        reasons: {
            status: 1, reason_pl1: 1, reason_prochot: 0, reason_ratl: 0,
            reason_soc_thermal: 1, reason_soc_avg_thermal: 0,
            reason_mem_thermal: 0, reason_vr_thermal: 0, reason_iccmax: 0,
        },
    })));
    assert.equal(component.read().thermalReason, 'SoC thermal');
});

test('the running-average thermal limit is a thermal reason, and PL1 is not', () => {
    const reasonFor = reasons =>
        driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {reasons})))[0].read().thermalReason;

    assert.equal(reasonFor({status: 1, reason_ratl: 1}), 'thermal (running average limit)');
    assert.equal(reasonFor({status: 1, reason_vr_thermalert: 1}),
        'voltage regulator thermal alert');
    assert.equal(reasonFor({status: 1, reason_pl1: 1, reason_pl2: 1, reason_vr_tdc: 1}), null,
        'power and current limits are not heat');
});

test('a parked engine is detected from its render/media C6 state', () => {
    for (const idle of ['gt-c6', 'GT-C6'])
        assert.equal(driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {idle, act: 300})))[0]
            .read().idle, true, `for ${idle}`);
});

test('an active C0 state is not idle', () => {
    assert.equal(driver.discover(machine(gt(`${DEVICE}/tile0/gt0`, {idle: 'gt-c0'})))[0]
        .read().idle, false);
});

test('an actual frequency of zero means parked even without an idle node', () => {
    const files = gt(`${DEVICE}/tile0/gt0`, {act: 0});
    delete files[`${DEVICE}/tile0/gt0/gtidle/idle_status`];
    assert.equal(driver.discover(machine(files))[0].read().idle, true);
});

test('an unreadable idle node with a running clock is not idle', () => {
    const files = gt(`${DEVICE}/tile0/gt0`, {act: 900});
    delete files[`${DEVICE}/tile0/gt0/gtidle/idle_status`];
    assert.equal(driver.discover(machine(files))[0].read().idle, false);
});

test('absent throttle registers read as null rather than as zero', () => {
    const files = gt(`${DEVICE}/tile0/gt0`);
    for (const node of ['status', 'reason_thermal', 'reason_prochot'])
        delete files[`${DEVICE}/tile0/gt0/freq0/throttle/${node}`];
    const reading = driver.discover(machine(files))[0].read();
    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot], [null, null, null]);
});

// A parked GT's throttle registers cannot mean anything, so the adapter does not
// read them. Note what this does *not* buy: by this point the device is awake.
// Every frequency attribute xe publishes is behind `guard(xe_pm_runtime)`, which
// resumes unconditionally, so the wake happened at the first read of the poll.
// The test below is the one that keeps the GPU asleep.
test('a parked GT does not have its throttle registers read', () => {
    const files = gt(`${DEVICE}/tile0/gt0`, {act: 0, status: 1, thermal: 1, prochot: 1});
    const reading = driver.discover(machine(files))[0].read();
    assert.equal(reading.idle, true);
    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot], [null, null, null]);
});

// The power fix that actually works. `xe_pm.h` defines `guard(xe_pm_runtime)`
// over `xe_pm_runtime_get()`, which ends in an unconditional `pm_runtime_resume()`
// — so act_freq, cur_freq, max_freq and gtidle/idle_status each resume a
// suspended GPU, and with an autosuspend delay of 1000 ms a short poll interval
// would stop it ever suspending. `power/runtime_status` belongs to the driver
// model, not to xe: `rpm_status_show()` formats a field and returns.
test('a runtime-suspended device is read without touching one guarded attribute', () => {
    const read = [];
    const files = {
        ...powered(DEVICE, 'suspended'),
        ...gt(`${DEVICE}/tile0/gt0`, {act: 1500, cur: 1500, status: 1, thermal: 1}),
    };
    const sysfs = fakeSysfs({
        files,
        links: {[`${DEVICE}/driver`]: '../../../bus/pci/drivers/xe'},
    });
    const component = driver.discover(sysfs)[0];

    // Only the read path is under test; discovery necessarily walks the device.
    const watched = fakeSysfs({
        files,
        links: {[`${DEVICE}/driver`]: '../../../bus/pci/drivers/xe'},
        onRead: path => read.push(path),
    });
    const reading = driver.discover(watched)[0].read();

    assert.equal(component.title, 'GPU — Render');
    assert.deepEqual(
        {idle: reading.idle, currentMhz: reading.currentMhz, rp0Mhz: reading.rp0Mhz},
        {idle: true, currentMhz: 0, rp0Mhz: 2000},
        'parked, and the guard-free ceiling is still reported');
    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot], [null, null, null]);

    // Discovery reads gtidle/name and rp0_freq; neither is guarded. What must
    // not appear is any attribute whose show function resumes the device.
    const GUARDED = ['act_freq', 'cur_freq', 'max_freq', 'idle_status'];
    const touched = read.filter(path => GUARDED.some(name => path.endsWith(`/${name}`)));
    assert.deepEqual(touched, [], `these reads would have woken the GPU: ${touched}`);
});

test('a device the PM core calls active is read normally', () => {
    const reading = driver.discover(
        machine(gt(`${DEVICE}/tile0/gt0`, {cur: 1500}), {runtimeStatus: 'active'}))[0].read();
    assert.equal(reading.idle, false);
    assert.equal(reading.currentMhz, 1500);
});

test('an absent runtime_status is not read as suspended', () => {
    // A kernel built without runtime PM publishes no such file, and there is
    // then no suspend to avoid. Falling back to the xe attributes is right;
    // treating a missing file as "suspended" would report a busy GPU as idle.
    const files = gt(`${DEVICE}/tile0/gt0`, {cur: 1500});
    const reading = driver.discover(fakeSysfs({
        files,
        links: {[`${DEVICE}/driver`]: '../../../bus/pci/drivers/xe'},
    }))[0].read();
    assert.equal(reading.idle, false);
    assert.equal(reading.currentMhz, 1500);
});

test('two xe devices produce distinct component ids', () => {
    const second = '/sys/bus/pci/devices/0000:03:00.0';
    const components = driver.discover(fakeSysfs({
        files: {...gt(`${DEVICE}/tile0/gt0`), ...gt(`${second}/tile0/gt0`)},
        links: {
            [`${DEVICE}/driver`]: '/bus/pci/drivers/xe',
            [`${second}/driver`]: '/bus/pci/drivers/xe',
        },
    }));
    assert.deepEqual(components.map(c => c.id), ['gpu:xe:0', 'gpu:xe:1']);
});

test('a GT whose RP0 is unreadable or zero is not discovered', () => {
    // Discovery must apply the same bar as the rule: otherwise the GT is kept,
    // reports "no data" forever, and suppresses the missing-GPU warning by
    // looking like a successful find.
    for (const rp0 of ['0', 'unknown', '']) {
        const files = gt(`${DEVICE}/tile0/gt0`);
        files[`${DEVICE}/tile0/gt0/freq0/rp0_freq`] = rp0;
        assert.deepEqual(driver.discover(machine(files)), [], `for RP0 ${JSON.stringify(rp0)}`);
    }
});

// `THROTTLE_ATTR_RO(status, U32_MAX)` masks nothing, and
// `xe_gt_throttle_get_limit_reasons()` has already reduced the register to the
// platform's own mask — so a status of 0 is the same read saying every reason
// bit is 0. Each reason attribute is another MMIO read behind its own
// `guard(xe_pm_runtime)`, so on a nominal machine that is seven per GT per poll
// for a question already answered.
test('a GT reporting no limit does not have its reason registers read', () => {
    const read = [];
    const files = gt(`${DEVICE}/tile0/gt0`, {reasons: {status: 0}});
    const sysfs = fakeSysfs({
        files: {...powered(), ...files},
        links: {[`${DEVICE}/driver`]: '../../../bus/pci/drivers/xe'},
        onRead: path => read.push(path),
    });
    const component = driver.discover(sysfs)[0];
    read.length = 0;
    const reading = component.read();

    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot],
        [0, null, null], 'null, because they were never read');
    assert.ok(read.some(path => path.endsWith('/throttle/status')), 'status is read');
    assert.deepEqual(read.filter(path => path.includes('/throttle/reason_')), [],
        'and nothing else in that register is');
});

test('a GT that is limited has every reason read, so the cause can be named', () => {
    const read = [];
    const sysfs = fakeSysfs({
        files: {...powered(), ...gt(`${DEVICE}/tile0/gt0`, {reasons: {status: 1}})},
        links: {[`${DEVICE}/driver`]: '../../../bus/pci/drivers/xe'},
        onRead: path => read.push(path),
    });
    driver.discover(sysfs)[0].read();
    for (const name of ['thermal', 'ratl', 'vr_thermalert', 'soc_thermal', 'prochot'])
        assert.ok(read.some(path => path.endsWith(`/throttle/reason_${name}`)), name);
});
