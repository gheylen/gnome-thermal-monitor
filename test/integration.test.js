// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// End to end through every layer except GNOME itself: a machine described as
// sysfs paths, driven through the real driver registry, the real Monitor and
// the real presentation, asserting on the strings a user would actually see.
//
// This is the test that catches layers wired together wrongly, which no unit
// test can — the shell adapter's only remaining job is to draw these results.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../src/domain/confidence.js';
import {discoverComponents} from '../src/domain/discovery.js';
import {Monitor} from '../src/domain/monitor.js';
import {DRIVERS} from '../src/hardware/index.js';
import {componentLines, panelLabel} from '../src/presentation.js';
import {Thresholds} from '../src/domain/thresholds.js';
import {fakeSysfs, filesIn} from './helpers/fake-sysfs.js';

const GPU = '/sys/bus/pci/devices/0000:00:02.0';
const CPU = '/sys/devices/system/cpu';
const THRESHOLDS = new Thresholds(88, 94);

/**
 * A Core Ultra-style laptop: four Intel cores with a coretemp package sensor, a
 * two-tile xe GPU (render busy, media parked), and an NPU.
 *
 * The returned handle keeps the sysfs contents mutable, so a test can advance a
 * counter or heat the package between polls exactly as the kernel would — and
 * the components discovered once at boot keep reading the live values.
 */
/**
 * The reason flags `xe_gt_throttle.c` registers for every non-Crescent-Island
 * platform (`throttle_attrs[]`), all clear. Describing the whole group matters:
 * an adapter that reported a power limit as heat would look correct against a
 * fixture that only carried `reason_thermal`.
 */
const XE_REASONS = {
    status: 0, reason_pl1: 0, reason_pl2: 0, reason_pl4: 0, reason_thermal: 0,
    reason_prochot: 0, reason_ratl: 0, reason_vr_thermalert: 0, reason_vr_tdc: 0,
};

function laptop() {
    const files = {
        ...filesIn('/sys/class/hwmon/hwmon4', {
            name: 'coretemp',
            // _crit is TjMax: where this part's thermal control circuit
            // engages. coretemp creates it for every sensor it creates.
            temp1_label: 'Package id 0', temp1_input: 55_000, temp1_crit: 100_000,
            // One channel per physical core, as `create_core_attrs()` builds
            // them: each with its own reading and its own TjMax. The package
            // sensor is the package's own DTS, not the maximum of these, so a
            // single hot core is a case the package channel cannot see.
            temp2_label: 'Core 0', temp2_input: 50_000, temp2_crit: 100_000,
            temp3_label: 'Core 1', temp3_input: 51_000, temp3_crit: 100_000,
            temp4_label: 'Core 2', temp4_input: 49_000, temp4_crit: 100_000,
            temp5_label: 'Core 3', temp5_input: 52_000, temp5_crit: 100_000,
        }),
        ...filesIn(`${GPU}/tile0/gt0/freq0`,
            {act_freq: 1900, cur_freq: 1900, max_freq: 2050, rp0_freq: 2050}),
        ...filesIn(`${GPU}/tile0/gt0/freq0/throttle`,
            XE_REASONS),
        ...filesIn(`${GPU}/tile0/gt0/gtidle`, {name: 'gt0-rc', idle_status: 'gt-c0'}),
        ...filesIn(`${GPU}/tile0/gt1/freq0`,
            {act_freq: 0, cur_freq: 700, max_freq: 1200, rp0_freq: 1200}),
        ...filesIn(`${GPU}/tile0/gt1/freq0/throttle`,
            XE_REASONS),
        ...filesIn(`${GPU}/tile0/gt1/gtidle`, {name: 'gt1-mc', idle_status: 'gt-c6'}),
        ...filesIn('/sys/class/accel/accel0/device', {
            npu_current_frequency_mhz: 950,
            npu_max_frequency_mhz: 1950,
            npu_busy_time_us: 1_000_000,
        }),
        // Every PCI device the driver model knows about carries this; the xe
        // adapter reads it first, because every xe attribute resumes the device.
        [`${GPU}/power/runtime_status`]: 'active',
        ...Object.fromEntries([0, 1, 2, 3].flatMap(core => [
            [`${CPU}/cpu${core}/thermal_throttle/core_throttle_count`, '10'],
            [`${CPU}/cpu${core}/thermal_throttle/core_throttle_total_time_ms`, '0'],
            // X86_FEATURE_PTS: every CPU carries a copy of the package event.
            [`${CPU}/cpu${core}/thermal_throttle/package_throttle_count`, '4'],
        ])),
    };

    // A port whose reads always go back to the live map.
    const live = fakeSysfs({files, links: {[`${GPU}/driver`]: '../../../bus/pci/drivers/xe'}});
    const sysfs = {...live, readText: path => live.readText(path)};

    return {
        sysfs,
        set: (path, value) => { files[path] = String(value); },
        packageMilliC: value => { files['/sys/class/hwmon/hwmon4/temp1_input'] = String(value); },
        /** One core's own sensor. Core N is `temp${N + 2}`. */
        coreMilliC: (core, value) => {
            files[`/sys/class/hwmon/hwmon4/temp${core + 2}_input`] = String(value);
        },
        /** Episode counts, one per core: the signal that says a throttle began. */
        throttleEpisodes: values => values.forEach((value, core) => {
            files[`${CPU}/cpu${core}/thermal_throttle/core_throttle_count`] = String(value);
        }),
        /** The NPU's busy-time accumulator, so an interval can show work done. */
        npuBusyUs: value => {
            files['/sys/class/accel/accel0/device/npu_busy_time_us'] = String(value);
        },
        /** The device's runtime-PM state, as the PM core reports it. */
        runtimeStatus: value => { files[`${GPU}/power/runtime_status`] = value; },
        /** Each CPU's copy of the package counter; a directed interrupt moves one. */
        packageEpisodes: values => values.forEach((value, cpu) => {
            files[`${CPU}/cpu${cpu}/thermal_throttle/package_throttle_count`] = String(value);
        }),
        /** Accumulated milliseconds: the signal that says an episode ended. */
        throttleTotalMs: values => values.forEach((value, core) => {
            files[`${CPU}/cpu${core}/thermal_throttle/core_throttle_total_time_ms`] =
                String(value);
        }),
    };
}

/**
 * Wire the whole stack the way extension.js does.
 *
 * The clock is required and has no default — the linger is arithmetic on it and
 * only a monotonic one is correct — so a test that does not care what time it is
 * still has to say so.
 */
function boot(sysfs, options = {}) {
    const warnings = [];
    const {components, missingCategories} =
        discoverComponents(DRIVERS, sysfs, message => warnings.push(message));
    return {
        monitor: new Monitor(components, {now: () => 0, ...options}),
        missingCategories,
        warnings,
    };
}

const popup = snapshot => snapshot.components.map(component => {
    const {status, detail} = componentLines(component);
    return [component.title, status, detail];
});

test('a Core Ultra laptop is discovered as CPU, two GPU tiles and an NPU', () => {
    const {monitor, missingCategories, warnings} = boot(laptop().sysfs);
    assert.deepEqual(monitor.components.map(component => component.id),
        ['cpu:intel', 'gpu:xe:0', 'gpu:xe:1', 'npu:intel']);
    assert.deepEqual(missingCategories, [], 'every category found hardware');
    assert.deepEqual(warnings, []);
});

test('component ids are unique, which is what keeps the popup sections apart', () => {
    const ids = boot(laptop().sysfs).monitor.components.map(component => component.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('an idle machine reads calm all the way to the panel', () => {
    const {monitor} = boot(laptop().sysfs);
    monitor.poll(THRESHOLDS);                       // prime the deltas
    const snapshot = monitor.poll(THRESHOLDS);

    assert.equal(snapshot.level, Confidence.LOW);
    assert.equal(snapshot.nominal, true);
    assert.equal(panelLabel(snapshot), '● 55°C');
    assert.deepEqual(popup(snapshot), [
        ['CPU', '█░░░ LOW   55°C', '  45°C below the throttle point (100°C)'],
        ['GPU — Render', '█░░░ LOW   Nominal', '  1900 / 2050 MHz'],
        ['GPU — Media/Codec', '░░░░ IDLE   Idle', '  700 / 1200 MHz'],
        ['NPU', '█░░░ LOW   Active', '  950 / 1950 MHz — no new work this interval'],
    ]);
});

test('a hot package alone is a warning, never a claim that it throttled', () => {
    const machine = laptop();
    const {monitor} = boot(machine.sysfs);
    monitor.poll(THRESHOLDS);

    machine.packageMilliC(90_000);
    const warm = monitor.poll(THRESHOLDS);
    assert.equal(warm.level, Confidence.MEDIUM);
    assert.equal(popup(warm)[0][2], '  10°C below the throttle point (100°C)');

    machine.packageMilliC(95_000);
    const critical = monitor.poll(THRESHOLDS);
    assert.equal(critical.level, Confidence.HIGH, 'the user asked to be told at 94');
    assert.equal(panelLabel(critical), '⚠ 95°C');
    assert.equal(popup(critical)[0][2],
        '  5°C below the throttle point (100°C) — above your critical threshold');

    machine.packageMilliC(100_000);
    const trip = monitor.poll(THRESHOLDS);
    assert.equal(trip.level, Confidence.HIGH);
    assert.equal(popup(trip)[0][2], '  At the throttle point (100°C)');
    assert.notEqual(trip.level, Confidence.CONFIRMED,
        'no counter moved, so this is still not proof');
});

test('the same temperature reads differently on a part with a higher TjMax', () => {
    // The whole point of reading TjMax. On a 110 °C part, 95 °C is fifteen
    // degrees of headroom — the panel still turns orange-red because the user
    // asked for it at 94, but the popup does not pretend the hardware agrees.
    const machine = laptop();
    machine.set('/sys/class/hwmon/hwmon4/temp1_crit', 110_000);
    const {monitor} = boot(machine.sysfs);
    monitor.poll(THRESHOLDS);

    machine.packageMilliC(95_000);
    const snapshot = monitor.poll(THRESHOLDS);
    assert.equal(popup(snapshot)[0][2],
        '  15°C below the throttle point (110°C) — above your critical threshold');

    // And on an 85 °C part the default critical of 94 is unreachable, so the
    // hardware is the only thing that can raise the alarm at all.
    machine.set('/sys/class/hwmon/hwmon4/temp1_crit', 85_000);
    machine.packageMilliC(85_000);
    const tripped = monitor.poll(THRESHOLDS);
    assert.equal(tripped.level, Confidence.HIGH);
    assert.equal(popup(tripped)[0][2], '  At the throttle point (85°C)');
});

// The CPU's trip point is offered to every rule, not just its own: the NPU
// shares a die with it and has no throttle signal of its own, so a CPU close to
// tripping is the nearest thing to a reason it can give for running slowly.
test('the CPU trip point reaches the NPU section through the shared context', () => {
    const machine = laptop();
    const {monitor} = boot(machine.sysfs);
    monitor.poll(THRESHOLDS);

    machine.npuBusyUs(1_500_000);      // the NPU did work this interval
    machine.packageMilliC(94_000);     // six degrees below the 100 °C trip point
    const hot = monitor.poll(THRESHOLDS);
    assert.equal(popup(hot).at(-1)[2],
        '  950 / 1950 MHz (49%) — CPU 6°C from its throttle point');

    machine.npuBusyUs(2_000_000);
    machine.packageMilliC(60_000);
    assert.equal(popup(monitor.poll(THRESHOLDS)).at(-1)[2], '  950 / 1950 MHz (49%)',
        'and says nothing when there is headroom to spare');
});

// TCC activation is a per-core event, and `coretemp.c` reads the package's own
// DTS rather than the maximum of the cores — so a single core can sit well above
// the package sensor. Measured on the package alone this machine is nominal
// right up until the counter moves, which is the moment this tier exists to
// precede.
test('one hot core is seen even though the package sensor is cool', () => {
    const machine = laptop();
    const {monitor} = boot(machine.sysfs);

    machine.packageMilliC(70_000);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.LOW, '70°C, and no core hotter');

    machine.coreMilliC(2, 93_000);
    const snapshot = monitor.poll(THRESHOLDS);
    assert.equal(snapshot.level, Confidence.MEDIUM);
    assert.equal(snapshot.temperatureC, 70, 'the panel still shows the package sensor');
    assert.deepEqual(popup(snapshot)[0], [
        'CPU', '██░░ MEDIUM   70°C',
        '  Core 2 at 93°C, 7°C below its throttle point (100°C)']);
});

test('a package throttle no core reported is still CONFIRMED, with no core count', () => {
    const machine = laptop();
    const {monitor} = boot(machine.sysfs);

    machine.packageMilliC(85_000);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.LOW, '85°C, nothing throttling');

    // The package sensor tripped; no individual core's did. With a directed
    // package interrupt only one CPU's copy of the counter is updated.
    machine.packageEpisodes([4, 4, 5, 4]);
    const hit = monitor.poll(THRESHOLDS);
    assert.equal(hit.level, Confidence.CONFIRMED);
    assert.equal(hit.throttleStarted, true);
    assert.equal(panelLabel(hit), '⚠ 85°C', 'no count: one package event is not N cores');
    assert.deepEqual(popup(hit)[0],
        ['CPU', '████ CONFIRMED   85°C', '  CPU package throttling — thermal (TCC)']);
});

test('a runtime-suspended GPU reads as idle rather than being woken up', () => {
    const machine = laptop();
    const {monitor} = boot(machine.sysfs);
    assert.equal(popup(monitor.poll(THRESHOLDS))[1][1], '█░░░ LOW   Nominal',
        'the render tile is busy while the device is active');

    machine.runtimeStatus('suspended');
    const asleep = monitor.poll(THRESHOLDS);
    assert.deepEqual(popup(asleep)[1],
        ['GPU — Render', '░░░░ IDLE   Idle', '  0 / 2050 MHz'],
        'answered from the PM core, with the guard-free ceiling still reported');
    assert.equal(popup(asleep)[2][1], '░░░░ IDLE   Idle', 'and the media tile too');
});

test('an advancing thermal (TCC) counter is CONFIRMED, counted, and lingers', () => {
    const machine = laptop();
    let clock = 0;
    const {monitor} = boot(machine.sysfs, {now: () => clock, lingerMs: 30_000});

    machine.packageMilliC(91_000);
    monitor.poll(THRESHOLDS);

    machine.throttleEpisodes([11, 10, 12, 10]); // cores 0 and 2 entered a throttle
    const hit = monitor.poll(THRESHOLDS);
    assert.equal(hit.level, Confidence.CONFIRMED);
    assert.equal(hit.throttleStarted, true);
    assert.equal(panelLabel(hit), '⚠ 91°C (2)');
    assert.deepEqual(popup(hit)[0],
        ['CPU', '████ CONFIRMED   91°C', '  2 of 4 cores throttling — thermal (TCC)']);

    // The burst ends — the counters stop moving — but the panel holds red.
    clock = 29_999;
    const lingering = monitor.poll(THRESHOLDS);
    assert.equal(lingering.level, Confidence.CONFIRMED);
    assert.equal(lingering.throttleStarted, false, 'one notification per burst');

    clock = 30_001;
    const recovered = monitor.poll(THRESHOLDS);
    assert.equal(recovered.level, Confidence.MEDIUM, 'linger expired; 91°C is still elevated');
    assert.equal(recovered.lingerUntilMs, null);
});

test('an xe PROCHOT flag reaches CONFIRMED through the whole stack', () => {
    const machine = laptop();
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/reason_prochot`, 1);
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/status`, 1);

    const snapshot = boot(machine.sysfs).monitor.poll(THRESHOLDS);
    assert.equal(snapshot.level, Confidence.CONFIRMED);
    assert.deepEqual(popup(snapshot)[1],
        ['GPU — Render', '████ CONFIRMED   Throttled', '  1900 / 2050 MHz — PROCHOT']);
});

// A GPU that is throttling for a thermal reason other than the plain `thermal`
// flag. `reason_ratl` is the running-average thermal limit; on Crescent Island it
// is one of the few thermal reasons published at all, because that platform's
// attribute group has no `reason_thermal`. The rule never learns either name —
// the adapter hands it a label, or null.
test('a thermal reason other than PROCHOT is named in the popup, at HIGH', () => {
    const machine = laptop();
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/reason_ratl`, 1);
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/status`, 1);

    const snapshot = boot(machine.sysfs).monitor.poll(THRESHOLDS);
    assert.deepEqual(popup(snapshot)[1], [
        'GPU — Render', '███░ HIGH   Throttled',
        '  1900 / 2050 MHz — thermal (running average limit)']);
});

// The counterpart, and the reason the reason table is a list of thermal limits
// rather than "anything that is not PROCHOT": PL1 is asserted under nearly every
// sustained load on a laptop, and saying "throttled — heat" for it would make the
// indicator permanently red on a perfectly cool machine.
test('a sustained power limit is not reported as a thermal throttle', () => {
    const machine = laptop();
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/reason_pl1`, 1);
    machine.set(`${GPU}/tile0/gt0/freq0/throttle/status`, 1);

    const snapshot = boot(machine.sysfs).monitor.poll(THRESHOLDS);
    assert.deepEqual(popup(snapshot)[1],
        ['GPU — Render', '█░░░ LOW   Nominal', '  1900 / 2050 MHz']);
});

test('a software frequency ceiling is not a thermal finding at any temperature', () => {
    // `max_freq` is a request software makes, not something the hardware
    // reports. Escalating it on a warm package used to paint the same red as a
    // confirmed PROCHOT, because HIGH and CONFIRMED share a colour. It is now
    // LOW — the user's own power policy, reported back to them — so the panel
    // level comes from the CPU rather than from TLP doing its job.
    const machine = laptop();
    machine.set(`${GPU}/tile0/gt0/freq0/max_freq`, 1000);

    const {monitor} = boot(machine.sysfs);
    const cool = monitor.poll(THRESHOLDS);
    assert.equal(cool.level, Confidence.LOW, '55°C and a capped GPU is not a warning');
    assert.equal(cool.nominal, true, 'and does not un-hide the indicator');
    assert.match(popup(cool)[1][2], /1000 \/ 2050 MHz ceiling — set by software/);
    assert.equal(popup(cool)[1][1], '█░░░ LOW   Frequency limited');

    machine.packageMilliC(90_000);
    const warm = monitor.poll(THRESHOLDS);
    assert.equal(warm.level, Confidence.MEDIUM, 'the CPU is what raised it, not the ceiling');
    assert.equal(popup(warm)[1][1], '█░░░ LOW   Frequency limited',
        'the GPU section says the same thing it did when the machine was cool');
});

test('the CPU package temperature is what the panel shows, not a GPU or NPU number', () => {
    const machine = laptop();
    machine.packageMilliC(73_000);
    const snapshot = boot(machine.sysfs).monitor.poll(THRESHOLDS);
    assert.equal(snapshot.temperatureC, 73);
});

test('thresholds set the wrong way round are ordered rather than obeyed', () => {
    const machine = laptop();
    machine.packageMilliC(90_000);
    const snapshot = boot(machine.sysfs).monitor.poll(new Thresholds(94, 88));
    assert.equal(snapshot.level, Confidence.MEDIUM, 'treated as warn 88 / crit 94');
});

test('a machine with no supported hardware comes up empty and names the missing categories', () => {
    const {monitor, missingCategories} = boot(fakeSysfs());
    assert.deepEqual(monitor.components, []);
    assert.deepEqual([...missingCategories].sort(), ['cpu', 'gpu', 'npu']);

    const snapshot = monitor.poll(THRESHOLDS);
    assert.equal(snapshot.level, Confidence.UNKNOWN);
    assert.equal(snapshot.nominal, true, 'no data is not an alarm');
    // Not "?°C": there is no sensor here that failed to read. This is the VM
    // and container case, and it is the one machine shape this project can be
    // certain it has run on.
    assert.equal(panelLabel(snapshot), '● —');
});

test('a machine with only a CPU warns about the GPU but not about the NPU', () => {
    const {missingCategories} = boot(fakeSysfs({files: filesIn('/sys/class/hwmon/hwmon0', {
        name: 'coretemp', temp1_label: 'Package id 0', temp1_input: '60000',
    })}));
    assert.deepEqual([...missingCategories].sort(), ['gpu', 'npu']);
});
