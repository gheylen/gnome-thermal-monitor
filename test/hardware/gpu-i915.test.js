// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel i915 GPU adapter.
//
// These fixtures are built from the kernel source, not from the adapter. The
// previous set was written the other way round and certified an adapter that
// looked for i915's attributes on the PCI device, under names i915 does not
// use — it could never have matched a real machine, and eight tests passed.
//
//   Location  `intel_gt_sysfs.c:gt_get_parent_obj()` →
//             `&gt->i915->drm.primary->kdev->kobj` = /sys/class/drm/cardN/
//   Per-GT    `intel_gt_sysfs_pm.c` `__ATTR(rps_##_name, …)` → rps_cur_freq_mhz,
//             rps_act_freq_mhz, rps_max_freq_mhz, rps_RP0_freq_mhz
//   Legacy    `__ATTR(gt_##_name, …)` on the device → gt_cur_freq_mhz, …
//   Reasons   `throttle_reason_attrs[]`: status, pl1, pl2, pl4, thermal,
//             prochot, ratl, vr_thermalert, vr_tdc — registered only for a real
//             GT object, and only when the perf-limit register exists

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import driver from '../../src/hardware/gpu-i915.js';
import {Thresholds} from '../../src/domain/thresholds.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const CARD = '/sys/class/drm/card0';

/** Per-GT layout: /sys/class/drm/cardN/gt/gtM/rps_*_freq_mhz */
const perGt = (gt, {act = 1000, cur = 1000, max = 1300, rp0 = 1300, reasons = {}} = {}) => ({
    ...filesIn(`${CARD}/gt/${gt}`, {
        rps_act_freq_mhz: act, rps_cur_freq_mhz: cur,
        rps_max_freq_mhz: max, rps_min_freq_mhz: 300, rps_RP0_freq_mhz: rp0,
    }),
    ...filesIn(`${CARD}/gt/${gt}`, {
        throttle_reason_status: 0, throttle_reason_prochot: 0,
        throttle_reason_thermal: 0, throttle_reason_pl1: 0,
        ...reasons,
    }),
});

/** Legacy layout: the same values as gt_*_freq_mhz on the card itself. */
const legacy = ({act = 1000, cur = 1000, max = 1300, rp0 = 1300, min = 300} = {}) =>
    filesIn(CARD, {
        gt_act_freq_mhz: act, gt_cur_freq_mhz: cur, gt_max_freq_mhz: max,
        gt_min_freq_mhz: min, gt_RP0_freq_mhz: rp0,
    });

const machine = (files, {driverName = 'i915'} = {}) => fakeSysfs({
    files,
    links: {[`${CARD}/device/driver`]: `../../../bus/pci/drivers/${driverName}`},
});

test('no i915 card means no components', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
    assert.deepEqual(driver.discover(machine(legacy(), {driverName: 'xe'})), [],
        'an xe card belongs to the other adapter');
});

test('the card is found under /sys/class/drm, not under the PCI device', () => {
    // The whole adapter used to look under /sys/bus/pci/devices/…, where i915
    // publishes none of this.
    const onPci = fakeSysfs({
        files: filesIn('/sys/bus/pci/devices/0000:00:02.0', {
            gt_cur_freq_mhz: 1000, gt_RP0_freq_mhz: 1300,
        }),
        links: {'/sys/bus/pci/devices/0000:00:02.0/driver': '/bus/pci/drivers/i915'},
    });
    assert.deepEqual(driver.discover(onPci), [], 'nothing lives there');
    assert.equal(driver.discover(machine(legacy())).length, 1, 'but it does under drm');
});

test('connector nodes beside the card are not mistaken for it', () => {
    // /sys/class/drm holds one node per connector as well as per card, and a
    // connector's `device` link points at the same PCI device — so the driver
    // check alone lets them through. Only the cardN shape distinguishes them.
    const connector = '/sys/class/drm/card0-eDP-1';
    const components = driver.discover(fakeSysfs({
        files: {...legacy(), ...filesIn(connector, {status: 'connected'})},
        links: {
            [`${CARD}/device/driver`]: '/bus/pci/drivers/i915',
            [`${connector}/device/driver`]: '/bus/pci/drivers/i915',
        },
    }));
    assert.deepEqual(components.map(c => c.id), ['gpu:i915:0']);
});

test('connector nodes are not probed at all', () => {
    // A laptop has several connectors, each of which would otherwise cost a
    // driver lookup and a directory listing on every discovery. Nothing about
    // a connector can ever match, so the shape check earns its place by
    // stopping before the reads rather than after them.
    const connectors = ['card0-eDP-1', 'card0-DP-1', 'card0-HDMI-A-1'];
    const files = {...legacy()};
    const links = {[`${CARD}/device/driver`]: '/bus/pci/drivers/i915'};
    for (const name of connectors) {
        Object.assign(files, filesIn(`/sys/class/drm/${name}`, {status: 'connected'}));
        links[`/sys/class/drm/${name}/device/driver`] = '/bus/pci/drivers/i915';
    }

    const touched = [];
    const inner = fakeSysfs({files, links});
    const watched = {
        ...inner,
        driverOf: path => { touched.push(path); return inner.driverOf(path); },
    };

    driver.discover(watched);
    assert.deepEqual(touched, [`${CARD}/device`], 'only the card was looked at');
});

test('the per-GT layout is discovered, one component per GT', () => {
    const components = driver.discover(machine({...perGt('gt0'), ...perGt('gt1')}));
    assert.deepEqual(components.map(c => [c.id, c.title]), [
        ['gpu:i915:0', 'GPU — gt0'],
        ['gpu:i915:1', 'GPU — gt1'],
    ]);
});

test('the per-GT layout reads the rps_ names, with RP0 capitalised', () => {
    const [component] = driver.discover(machine(perGt('gt0', {cur: 900, max: 1100, rp0: 1300})));
    assert.deepEqual(component.read(), {
        currentMhz: 900, maxMhz: 1100, rp0Mhz: 1300, idle: false,
        // `throttle_reason_status` is 0, which is the same register read saying
        // every reason bit is 0 — so the reasons are not read at all, and report
        // null rather than a zero this adapter never saw.
        throttled: 0, thermalReason: null, prochot: null,
    });
});

test('the legacy layout reads the gt_ names, also with RP0 capitalised', () => {
    const [component] = driver.discover(machine(legacy({cur: 800, max: 1200, rp0: 1350})));
    assert.deepEqual(component.read(), {
        currentMhz: 800, maxMhz: 1200, rp0Mhz: 1350, idle: false,
        throttled: null, thermalReason: null, prochot: null,
    });
});

// The adapter's own comment used to say i915 publishes no throttle reasons. It
// publishes nine, on every Gen11+ GT, in the same directory as the frequencies.
test('a PROCHOT reason on a GT reaches CONFIRMED', () => {
    const files = perGt('gt0', {reasons: {throttle_reason_status: 1, throttle_reason_prochot: 1}});
    const [component] = driver.discover(machine(files));
    const verdict = component.assess(component.read(), null,
        {packageTempC: 50, thresholds: new Thresholds(85, 95)});
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /PROCHOT/);
});

test('a thermal reason on a GT reaches HIGH', () => {
    const files = perGt('gt0', {reasons: {throttle_reason_status: 1, throttle_reason_thermal: 1}});
    const [component] = driver.discover(machine(files));
    assert.equal(component.assess(component.read(), null, {packageTempC: 50, thresholds: new Thresholds(85, 95)}).level,
        Confidence.HIGH);
});

test('every thermal reason i915 publishes is named, and no power limit is', () => {
    const reasonFor = reasons => {
        const [component] = driver.discover(machine(perGt('gt0', {reasons})));
        return component.read().thermalReason;
    };

    assert.equal(reasonFor({throttle_reason_status: 1, throttle_reason_ratl: 1}),
        'thermal (running average limit)');
    assert.equal(reasonFor({throttle_reason_status: 1, throttle_reason_vr_thermalert: 1}),
        'voltage regulator thermal alert');
    assert.equal(reasonFor({throttle_reason_status: 1, throttle_reason_pl1: 1}), null,
        'a sustained power limit is asserted under nearly every load; it is not heat');
    assert.equal(reasonFor({throttle_reason_status: 1, throttle_reason_vr_tdc: 1}), null,
        'thermal design *current* is a current limit');
});

test('the reason the hardware gave is the reason the user is shown', () => {
    const files = perGt('gt0', {
        cur: 900, rp0: 1300,
        reasons: {throttle_reason_status: 1, throttle_reason_ratl: 1},
    });
    const [component] = driver.discover(machine(files));
    const verdict = component.assess(component.read(), null,
        {packageTempC: 50, thresholds: new Thresholds(85, 95)});
    assert.deepEqual([verdict.level, verdict.summary, verdict.detail], [
        Confidence.HIGH, 'Throttled', '900 / 1300 MHz — thermal (running average limit)']);
});

test('a GT with no reason files reads them as absent, not as zero', () => {
    // Pre-Gen11, or a kernel without the perf-limit register.
    const files = filesIn(`${CARD}/gt/gt0`, {
        rps_act_freq_mhz: 1000, rps_cur_freq_mhz: 1000,
        rps_max_freq_mhz: 1300, rps_RP0_freq_mhz: 1300,
    });
    const reading = driver.discover(machine(files))[0].read();
    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot], [null, null, null]);
});

test('a parked GT is idle, and its throttle reasons are not read', () => {
    // Each reason read goes through `with_intel_runtime_pm`, which resumes a
    // suspended GPU; a parked GT cannot be throttling, so it is not worth waking
    // for. Observed rather than inferred: a parked GT whose status is unreadable
    // has a null status either way, so asserting on the reading alone would let
    // the skip be removed without a test noticing.
    const files = perGt('gt0', {
        act: 0,
        reasons: {throttle_reason_status: 1, throttle_reason_thermal: 1,
            throttle_reason_prochot: 1},
    });
    const read = [];
    const sysfs = fakeSysfs({
        files,
        links: {[`${CARD}/device/driver`]: '../../../bus/pci/drivers/i915'},
        onRead: path => read.push(path),
    });
    const component = driver.discover(sysfs)[0];
    read.length = 0;
    const reading = component.read();

    assert.equal(reading.idle, true);
    assert.deepEqual([reading.throttled, reading.thermalReason, reading.prochot],
        [null, null, null], 'not read while parked');
    assert.deepEqual(read.filter(path => path.includes('throttle_reason_')), [],
        'and no reason attribute was touched, whatever the reading says');
});

test('a GT whose RP0 is unreadable or zero is not discovered', () => {
    for (const rp0 of ['0', 'unknown', '']) {
        const files = perGt('gt0');
        files[`${CARD}/gt/gt0/rps_RP0_freq_mhz`] = rp0;
        assert.deepEqual(driver.discover(machine(files)), [], `for RP0 ${JSON.stringify(rp0)}`);
    }
});

test('a legacy card whose RP0 is unreadable or zero is not discovered', () => {
    for (const rp0 of ['0', 'unknown']) {
        const files = legacy();
        files[`${CARD}/gt_RP0_freq_mhz`] = rp0;
        assert.deepEqual(driver.discover(machine(files)), [], `for RP0 ${JSON.stringify(rp0)}`);
    }
});

test('a card offering GTs never also reports a legacy GT', () => {
    const components = driver.discover(machine({...perGt('gt0'), ...legacy()}));
    assert.deepEqual(components.map(c => c.title), ['GPU — gt0']);
});

// /sys/class/drm holds a render node and a `version` file beside every card,
// and the render node's `device` link points at the same PCI device — so a
// looser match than `^card\\d+$` would discover the same GPU twice, under two
// ids, with two popup sections. No fixture had one in it.
test('a render node beside the card is not mistaken for a second GPU', () => {
    const components = driver.discover(fakeSysfs({
        files: {
            ...perGt('gt0'),
            '/sys/class/drm/version': 'drm 1.1.0 20060810',
            ...filesIn('/sys/class/drm/renderD128', {dev: '226:128'}),
        },
        links: {
            [`${CARD}/device/driver`]: '/bus/pci/drivers/i915',
            '/sys/class/drm/renderD128/device/driver': '/bus/pci/drivers/i915',
        },
    }));
    assert.deepEqual(components.map(c => c.id), ['gpu:i915:0']);
});

// A machine whose first DRM card belongs to another vendor — an AMD or NVIDIA
// discrete GPU enumerating before the Intel GPU. The index in a component id
// comes from discovery order over the cards this adapter claims, so a card it
// does not own must not consume one, and must not be read from either.
test('a card belonging to another driver is skipped without consuming an index', () => {
    const intel = '/sys/class/drm/card1';
    const components = driver.discover(fakeSysfs({
        files: {
            ...filesIn('/sys/class/drm/card0', {
                gt_act_freq_mhz: 500, gt_cur_freq_mhz: 500,
                gt_max_freq_mhz: 800, gt_min_freq_mhz: 200, gt_RP0_freq_mhz: 800,
            }),
            ...filesIn(`${intel}/gt/gt0`, {
                rps_act_freq_mhz: 1000, rps_cur_freq_mhz: 1000,
                rps_max_freq_mhz: 1300, rps_min_freq_mhz: 300, rps_RP0_freq_mhz: 1300,
                throttle_reason_status: 0, throttle_reason_prochot: 0,
                throttle_reason_thermal: 0,
            }),
        },
        links: {
            '/sys/class/drm/card0/device/driver': '/bus/pci/drivers/amdgpu',
            [`${intel}/device/driver`]: '/bus/pci/drivers/i915',
        },
    }));
    assert.deepEqual(components.map(c => c.id), ['gpu:i915:0'],
        'the foreign card is not ours, and index 0 belongs to the first one that is');
    assert.equal(components[0].read().currentMhz, 1000, 'and it reads the Intel card');
});

test('a second card does not inherit the first card legacy suppression', () => {
    const second = '/sys/class/drm/card1';
    const components = driver.discover(fakeSysfs({
        files: {
            ...perGt('gt0'),
            ...filesIn(second, {
                gt_act_freq_mhz: 700, gt_cur_freq_mhz: 700,
                gt_max_freq_mhz: 1000, gt_min_freq_mhz: 300, gt_RP0_freq_mhz: 1000,
            }),
        },
        links: {
            [`${CARD}/device/driver`]: '/bus/pci/drivers/i915',
            [`${second}/device/driver`]: '/bus/pci/drivers/i915',
        },
    }));
    assert.deepEqual(components.map(c => [c.id, c.title]), [
        ['gpu:i915:0', 'GPU — gt0'],
        ['gpu:i915:1', 'GPU — GT'],
    ]);
    assert.equal(components[1].read().currentMhz, 700);
});

// `GT0_PERF_LIMIT_REASONS_MASK` is 0xde3 — precisely the bits the individual
// `throttle_reason_*` attributes pick from — so `throttle_reason_status` at 0 is
// the same register saying all of them are 0. Each of those reads goes through
// `with_intel_runtime_pm` and an MMIO read, so on a nominal machine they are
// eight per GT per poll for an answer already in hand.
test('a GT reporting no limit does not have its reason files read', () => {
    const files = perGt('gt0', {reasons: {throttle_reason_status: 0}});
    const read = [];
    const sysfs = fakeSysfs({
        files,
        links: {[`${CARD}/device/driver`]: '../../../bus/pci/drivers/i915'},
        onRead: path => read.push(path),
    });
    const component = driver.discover(sysfs)[0];
    read.length = 0;
    component.read();

    assert.ok(read.some(path => path.endsWith('throttle_reason_status')), 'status is read');
    assert.deepEqual(read.filter(path => /throttle_reason_(?!status)/.test(path)), [],
        'and nothing else in that register is');
});

test('a GT that is limited has every reason read, so the cause can be named', () => {
    const files = perGt('gt0', {reasons: {throttle_reason_status: 1}});
    const read = [];
    const sysfs = fakeSysfs({
        files,
        links: {[`${CARD}/device/driver`]: '../../../bus/pci/drivers/i915'},
        onRead: path => read.push(path),
    });
    driver.discover(sysfs)[0].read();
    for (const name of ['thermal', 'ratl', 'vr_thermalert', 'prochot'])
        assert.ok(read.some(path => path.endsWith(`throttle_reason_${name}`)), name);
});
