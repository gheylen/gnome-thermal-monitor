// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel CPU adapter, driven against a described machine rather than a kernel.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import driver from '../../src/hardware/cpu-intel.js';
import {fakeSysfs, filesIn} from '../helpers/fake-sysfs.js';

const CPU_ROOT = '/sys/devices/system/cpu';
const COUNTER = 'core_throttle_count';
const TOTAL_MS = 'core_throttle_total_time_ms';

/** @param {number[]} counts Episode count, one entry per cpuN. */
const cores = counts => Object.fromEntries(counts.flatMap((value, i) => [
    [`${CPU_ROOT}/cpu${i}/thermal_throttle/${COUNTER}`, String(value)],
    [`${CPU_ROOT}/cpu${i}/thermal_throttle/${TOTAL_MS}`, '0'],
]));

/**
 * `topology/core_cpus_list` for one CPU: the kernel's own "list of CPUs within
 * the same core", rendered the way `cpumap_print_list_to_buf()` renders it —
 * runs collapsed to `a-b`, runs joined by commas. Every sibling of a core gets
 * the identical string, which is what makes it usable as the grouping key.
 *
 * @param {number} cpu     The CPU this file belongs to.
 * @param {number[]} group Every CPU of its core, ascending, including itself.
 */
const siblings = (cpu, group) => {
    const runs = [];
    for (const n of group) {
        const last = runs.at(-1);
        if (last && last[1] === n - 1) last[1] = n;
        else runs.push([n, n]);
    }
    const list = runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(',');
    return {[`${CPU_ROOT}/cpu${cpu}/topology/core_cpus_list`]: list};
};

/**
 * The counter triple as `read()` returns it, for a CPU whose episode count is
 * `n`. `maxMs` defaults to null because `cores()` below describes the two
 * attributes this suite mostly cares about and leaves the lifetime one absent,
 * which is also what an older kernel would do.
 */
const counters = (episodes, totalMs = 0, maxMs = null) => ({episodes, totalMs, maxMs});

const coretemp = (millidegrees, {label = 'Package id 0', index = 1, crit = 100_000} = {}) =>
    filesIn('/sys/class/hwmon/hwmon2', {
        name: 'coretemp',
        [`temp${index}_label`]: label,
        [`temp${index}_input`]: String(millidegrees),
        // create_core_attrs() builds _crit for every sensor it creates, and
        // fills it with TjMax. A fixture without it is not a real machine.
        ...(crit === null ? {} : {[`temp${index}_crit`]: String(crit)}),
    });

const discoverOne = files => {
    const components = driver.discover(fakeSysfs({files}));
    assert.equal(components.length, 1, 'expected exactly one CPU component');
    return components[0];
};

// TjMax is what makes a temperature mean anything: coretemp computes
// `_input` as `tjmax - digital_readout`, so `_crit - _input` recovers the
// hardware's own count of degrees remaining before it throttles.
test('the trip point is offered as a projection, beside the temperature', () => {
    // The Monitor hands both to every rule, so the NPU — which shares a die and
    // has no throttle signal of its own — can say how close the CPU is to
    // tripping. Reading it into the CPU's own verdict is not enough.
    const component = discoverOne({...cores([10]), ...coretemp(84_000, {crit: 105_000})});
    const reading = component.read();
    assert.equal(component.temperatureC(reading), 84);
    assert.equal(component.throttlePointC(reading), 105);
    assert.equal(component.throttlePointC(null), null, 'and survives a failed read');
});

test('the throttle point is read from the package channel', () => {
    const reading = discoverOne({...cores([10]), ...coretemp(84_500, {crit: 105_000})}).read();
    assert.equal(reading.packageTempC, 85, 'rounded, not truncated');
    assert.equal(reading.throttlePointC, 105);
});

test('the throttle point comes from the same channel as the temperature', () => {
    // A core sensor sitting on temp2 must not have its TjMax picked up for the
    // package on temp1 — they can differ, and the pairing is what matters.
    const files = {
        ...cores([10]),
        ...filesIn('/sys/class/hwmon/hwmon2', {
            name: 'coretemp',
            temp1_label: 'Package id 0', temp1_input: '80000', temp1_crit: '100000',
            temp2_label: 'Core 0', temp2_input: '78000', temp2_crit: '90000',
        }),
    };
    const reading = discoverOne(files).read();
    assert.deepEqual([reading.packageTempC, reading.throttlePointC], [80, 100]);
});

test('an absent throttle point reads as null rather than as zero', () => {
    const reading = discoverOne({...cores([10]), ...coretemp(80_000, {crit: null})}).read();
    assert.equal(reading.packageTempC, 80);
    assert.equal(reading.throttlePointC, null);
});

test('the thermal-zone fallback offers no throttle point', () => {
    // x86_pkg_temp's trip points are the programmable thresholds, not TjMax,
    // so a machine on this path has none to give and must not invent one.
    const files = {
        ...cores([10]),
        ...filesIn('/sys/class/thermal/thermal_zone3', {type: 'x86_pkg_temp', temp: '77000'}),
    };
    const reading = discoverOne(files).read();
    assert.equal(reading.packageTempC, 77);
    assert.equal(reading.throttlePointC, null);
});

test('a machine with neither counters nor a sensor yields no component', () => {
    assert.deepEqual(driver.discover(fakeSysfs()), []);
});

test('an unrelated hwmon is not mistaken for coretemp', () => {
    assert.deepEqual(driver.discover(fakeSysfs({files: filesIn('/sys/class/hwmon/hwmon0', {
        name: 'nvme', temp1_label: 'Composite', temp1_input: '40000',
    })})), []);
});

test('the package sensor is identified by the hwmon name, not by the label alone', () => {
    // Labels are not unique across hwmon devices, so matching "Package id 0"
    // anywhere would pick up whichever device happened to enumerate first.
    const component = discoverOne({
        ...filesIn('/sys/class/hwmon/hwmon0', {
            name: 'acpitz', temp1_label: 'Package id 0', temp1_input: '99000',
        }),
        ...coretemp(60000),
    });
    assert.equal(component.read().packageTempC, 60);
});

test('a discovered CPU has a stable identity and offers its temperature', () => {
    const component = discoverOne({...cores([0]), ...coretemp(55000)});
    assert.equal(component.id, 'cpu:intel');
    assert.equal(component.title, 'CPU');
    assert.equal(component.temperatureC(component.read()), 55);
});

test('both counters are read per CPU, in CPU order', () => {
    const component = discoverOne(cores([10, 20, 30, 40]));
    assert.deepEqual(component.read().cores,
        [10, 20, 30, 40].map(n => [counters(n)]));
});

// The two counters move at opposite ends of an episode, so the rule needs both:
// `count` says a throttle began, `total_time_ms` says one ended and how long.
test('the episode count and the accumulated time are both read', () => {
    const files = cores([3]);
    files[`${CPU_ROOT}/cpu0/thermal_throttle/${TOTAL_MS}`] = '1250';
    assert.deepEqual(discoverOne(files).read().cores, [[counters(3, 1250)]]);
});

test('a CPU exposing the count but not the accumulator still reports', () => {
    const files = cores([3]);
    delete files[`${CPU_ROOT}/cpu0/thermal_throttle/${TOTAL_MS}`];
    assert.deepEqual(discoverOne(files).read().cores, [[counters(3, null)]]);
});

test('CPUs are ordered numerically, so cpu10 does not sort before cpu2', () => {
    const counts = Array.from({length: 12}, (_, i) => i * 100);
    const component = discoverOne(cores(counts));
    assert.deepEqual(component.read().cores, counts.map(n => [counters(n)]));
});

test('millidegrees are rounded to whole degrees', () => {
    for (const [millidegrees, expected] of [[55499, 55], [55500, 56], [0, 0]])
        assert.equal(discoverOne(coretemp(millidegrees)).read().packageTempC, expected);
});

test('counters alone are enough to be useful', () => {
    const reading = discoverOne(cores([0, 0])).read();
    assert.deepEqual(reading.cores, [[counters(0)], [counters(0)]]);
    assert.equal(reading.packageTempC, null);
});

test('a temperature alone is enough to be useful', () => {
    const reading = discoverOne(coretemp(72000)).read();
    assert.deepEqual(reading.cores, []);
    assert.equal(reading.packageTempC, 72);
});

test('only the package sensor is used, not per-core inputs', () => {
    const component = discoverOne({
        ...filesIn('/sys/class/hwmon/hwmon2', {
            name: 'coretemp',
            temp1_label: 'Package id 0', temp1_input: '61000',
            temp2_label: 'Core 0', temp2_input: '99000',
        }),
    });
    assert.equal(component.read().packageTempC, 61);
});

test('the x86_pkg_temp thermal zone is the fallback when coretemp is absent', () => {
    const component = discoverOne({
        '/sys/class/thermal/thermal_zone0/type': 'acpitz',
        '/sys/class/thermal/thermal_zone0/temp': '30000',
        '/sys/class/thermal/thermal_zone7/type': 'x86_pkg_temp',
        '/sys/class/thermal/thermal_zone7/temp': '68000',
    });
    assert.equal(component.read().packageTempC, 68);
});

test('the thermal-zone fallback is found beyond the first ten zones', () => {
    const files = {};
    for (let i = 0; i < 20; i++) files[`/sys/class/thermal/thermal_zone${i}/type`] = 'acpitz';
    files['/sys/class/thermal/thermal_zone17/type'] = 'x86_pkg_temp';
    files['/sys/class/thermal/thermal_zone17/temp'] = '81000';
    assert.equal(discoverOne(files).read().packageTempC, 81);
});

test('coretemp wins over the thermal zone when both exist', () => {
    const component = discoverOne({
        ...coretemp(60000),
        '/sys/class/thermal/thermal_zone7/type': 'x86_pkg_temp',
        '/sys/class/thermal/thermal_zone7/temp': '99000',
    });
    assert.equal(component.read().packageTempC, 60);
});

test('a core whose counter vanishes between polls reads as null, not as zero', () => {
    // Discovery already fixed the core list, so the core stays in the reading;
    // its value must degrade rather than silently become a delta of zero.
    const files = cores([10, 20]);
    const blocked = new Set();
    const inner = fakeSysfs({files});
    const flaky = {
        ...inner,
        readText: path => (blocked.has(path) ? null : inner.readText(path)),
        readInt: path => (blocked.has(path) ? null : inner.readInt(path)),
    };

    const component = driver.discover(flaky)[0];
    assert.deepEqual(component.read().cores, [[counters(10)], [counters(20)]]);

    blocked.add(`${CPU_ROOT}/cpu1/thermal_throttle/${COUNTER}`);
    assert.deepEqual(component.read().cores,
        [[counters(10)], [counters(null, 0)]]);
});

test('a garbage temperature reads as no temperature', () => {
    const files = coretemp(0);
    files['/sys/class/hwmon/hwmon2/temp1_input'] = 'N/A';
    assert.equal(discoverOne(files).read().packageTempC, null);
});

test('a coretemp hwmon with no package label falls through to the thermal zone', () => {
    const component = discoverOne({
        ...coretemp(60000, {label: 'Core 0'}),
        '/sys/class/thermal/thermal_zone3/type': 'x86_pkg_temp',
        '/sys/class/thermal/thermal_zone3/temp': '70000',
    });
    assert.equal(component.read().packageTempC, 70);
});

test('discovery reads sysfs once; later polls do not re-scan', () => {
    let listCalls = 0;
    const files = {...cores([1, 2]), ...coretemp(50000)};
    const inner = fakeSysfs({files});
    const counting = {...inner, list: path => { listCalls++; return inner.list(path); }};

    const component = driver.discover(counting)[0];
    const afterDiscovery = listCalls;
    component.read();
    component.read();
    assert.equal(listCalls, afterDiscovery, 'polling must not enumerate directories');
});

// The thermal event is a property of the physical core, but sysfs publishes the
// counter per logical CPU. Counting both SMT siblings would double both the throttling
// count and the total — "2 of 16" on an 8-core chip where one core throttled.
test('SMT siblings are collapsed to one entry per physical core', () => {
    const files = {};
    // 8 physical cores, 2 threads each: cpu0..cpu7 are threads 0, cpu8..cpu15 threads 1.
    for (let cpu = 0; cpu < 16; cpu++) {
        const core = cpu % 8;
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: String(core * 10), [TOTAL_MS]: '0'}));
        Object.assign(files, siblings(cpu, [core, core + 8]));
    }

    const reading = discoverOne(files).read();
    assert.equal(reading.cores.length, 8, 'one entry per physical core');
    // Each core holds both of its logical CPUs, which report the same value here.
    assert.deepEqual(reading.cores,
        [0, 10, 20, 30, 40, 50, 60, 70].map(n => [counters(n), counters(n)]));
});

// The grouping used to be a key composed from `physical_package_id`, `die_id`
// and `core_id`, all three of which the ABI calls platform-dependent — and
// which merged two distinct cores whenever a `core_id` repeated across packages
// or dies, under-counting the "of M" denominator. A sibling list cannot repeat:
// every list contains the CPU it belongs to, so two lists that differ describe
// disjoint sets of CPUs.
test('CPUs the kernel does not list as siblings are separate cores', () => {
    const files = {};
    for (const cpu of [0, 1, 2]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: String(cpu), [TOTAL_MS]: '0'}));
        // Each on its own core, however the platform numbers its packages,
        // dies and cores — none of which is read any more.
        Object.assign(files, siblings(cpu, [cpu]));
    }
    assert.deepEqual(discoverOne(files).read().cores,
        [[counters(0)], [counters(1)], [counters(2)]]);
});

// `core_cpus_list` is the name since 5.3; `thread_siblings_list` is the same
// file's deprecated name, which is all a kernel older than that publishes.
test('a kernel predating the rename groups by thread_siblings_list', () => {
    const files = {};
    for (const cpu of [0, 1, 2, 3]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: '5', [TOTAL_MS]: '0'}));
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/topology`,
            {thread_siblings_list: cpu % 2 === 0 ? '0,2' : '1,3'}));
    }
    assert.equal(discoverOne(files).read().cores.length, 2, 'two physical cores');
});

test('the current name wins where a kernel publishes both', () => {
    const files = {};
    for (const cpu of [0, 1]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: '5', [TOTAL_MS]: '0'}));
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/topology`,
            {core_cpus_list: '0-1', thread_siblings_list: String(cpu)}));
    }
    assert.equal(discoverOne(files).read().cores.length, 1, 'one core, from core_cpus_list');
});

// thermal_throttle_add_dev() adds package_throttle_count to the same sysfs group
// for any CPU with X86_FEATURE_PTS, which is every Intel part this targets. Each
// CPU holds a copy of one package-scope event, so the adapter returns them flat
// rather than grouped by core — grouping would invite the rule to count them.
test('the package counter is read once per logical CPU, ungrouped', () => {
    const files = {};
    for (let cpu = 0; cpu < 4; cpu++) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`, {
            [COUNTER]: '0', [TOTAL_MS]: '0', package_throttle_count: String(cpu + 1),
        }));
        Object.assign(files, siblings(cpu, cpu % 2 === 0 ? [0, 2] : [1, 3]));
    }

    const reading = discoverOne(files).read();
    assert.equal(reading.cores.length, 2, 'two physical cores');
    assert.deepEqual(reading.packageEpisodes, [1, 3, 2, 4],
        'one entry per logical CPU, in the order discovery fixed the groups');
});

test('a CPU without the package attribute reports null rather than dropping out', () => {
    const reading = discoverOne(cores([10, 20])).read();
    assert.deepEqual(reading.packageEpisodes, [null, null]);
    assert.equal(reading.cores.length, 2, 'the core counters are unaffected');
});

test('a machine exposing no topology falls back to one entry per logical CPU', () => {
    const component = discoverOne(cores([10, 20, 30, 40]));
    assert.equal(component.read().cores.length, 4);
});

test('a partial topology is not used at all, rather than mixing cores with threads', () => {
    // cpu0 and cpu1 are identifiable siblings; cpu2 has no topology. Collapsing
    // the pair and keeping cpu2 would give three entries for two cores, so
    // "N of M cores" would be counting two different things at once.
    const files = {...cores([10, 20, 30])};
    for (const cpu of [0, 1])
        Object.assign(files, siblings(cpu, [0, 1]));

    assert.deepEqual(discoverOne(files).read().cores,
        [[counters(10)], [counters(20)], [counters(30)]],
        'all three logical CPUs, consistently in threads');
});

// Discovery runs once and a logical CPU can go offline afterwards, so the core's
// CPUs are all kept and read separately. Collapsing them to one number here
// would let the reported value switch source between polls, and these
// accumulators are per logical CPU — a switch would look like a jump, which the
// rule reads as a confirmed throttle.
test('every one of a core\'s CPUs is read, separately', () => {
    const files = {};
    for (const cpu of [0, 1, 2, 3]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: String(cpu * 100), [TOTAL_MS]: '0'}));
        Object.assign(files, siblings(cpu, cpu % 2 === 0 ? [0, 2] : [1, 3]));
    }
    // cpu0/cpu2 are core 0; cpu1/cpu3 are core 1.
    assert.deepEqual(discoverOne(files).read().cores, [
        [counters(0), counters(200)],
        [counters(100), counters(300)],
    ]);
});

test('a CPU going offline blanks only its own slot, not its core', () => {
    const files = {};
    for (const cpu of [0, 2]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`,
            {[COUNTER]: '7', [TOTAL_MS]: '0'}));
        Object.assign(files, siblings(cpu, [0, 2]));
    }

    const blocked = new Set();
    const inner = fakeSysfs({files});
    const flaky = {
        ...inner,
        readText: path => (blocked.has(path) ? null : inner.readText(path)),
        readInt: path => (blocked.has(path) ? null : inner.readInt(path)),
    };

    const component = driver.discover(flaky)[0];
    assert.deepEqual(component.read().cores, [[counters(7), counters(7)]]);

    blocked.add(`${CPU_ROOT}/cpu0/thermal_throttle/${COUNTER}`);
    assert.deepEqual(component.read().cores,
        [[counters(null, 0), counters(7)]],
        'the offline CPU reads null; its sibling still answers for itself');
});

test('a CPU whose counter is unreadable at discovery is not part of the core list', () => {
    // Discovery is what fixes the list; a counter that cannot be read then is
    // not a core this backend can report on.
    const files = {...cores([10, 20])};
    const sysfs = fakeSysfs({files, unreadable: [
        `${CPU_ROOT}/cpu1/thermal_throttle/${COUNTER}`,
    ]});
    assert.deepEqual(driver.discover(sysfs)[0].read().cores, [[counters(10)]]);
});

// `create_core_attrs()` is the same function for a package sensor and a core
// sensor, so every "Core N" channel carries its own `_input` and `_crit`. TCC is
// a per-core event and `coretemp.c` reads the package's own DTS rather than the
// maximum of the cores, so the core channels are what let the rule see a single
// hot core before its counter moves.
test('the core channels are read beside the package one, each with its own trip point', () => {
    const files = {
        ...cores([0, 0]),
        ...coretemp(60_000),
        ...coretemp(94_000, {label: 'Core 0', index: 2}),
        ...coretemp(71_000, {label: 'Core 1', index: 3, crit: 90_000}),
    };
    assert.deepEqual(discoverOne(files).read().coreTemps, [
        {label: 'Core 0', tempC: 94, throttlePointC: 100, targetC: null},
        {label: 'Core 1', tempC: 71, throttlePointC: 90, targetC: null},
    ]);
});

test('channels that are neither the package nor a core are left alone', () => {
    const files = {
        ...cores([0]),
        ...coretemp(60_000),
        // hwmon devices carry all sorts; only "Core N" is a core.
        ...coretemp(50_000, {label: 'Core temperature', index: 2}),
        ...coretemp(55_000, {label: 'Package id 1', index: 3}),
    };
    assert.deepEqual(discoverOne(files).read().coreTemps, []);
});

// One coretemp device per package, each labelling its cores from zero. Pairing a
// core on one socket with a package reading from the other describes no machine.
test('the core channels come from the package sensor\'s own device', () => {
    const files = {
        ...cores([0]),
        ...filesIn('/sys/class/hwmon/hwmon1', {
            name: 'coretemp',
            temp1_label: 'Package id 1', temp1_input: '80000', temp1_crit: '100000',
            temp2_label: 'Core 0', temp2_input: '99000', temp2_crit: '100000',
        }),
        ...coretemp(60_000),
        ...coretemp(62_000, {label: 'Core 0', index: 2}),
    };
    assert.deepEqual(discoverOne(files).read().coreTemps,
        [{label: 'Core 0', tempC: 62, throttlePointC: 100, targetC: null}]);
});

test('the thermal-zone fallback publishes no core channels', () => {
    const files = {
        ...cores([0]),
        ...filesIn('/sys/class/thermal/thermal_zone0', {type: 'x86_pkg_temp', temp: '70000'}),
    };
    const reading = discoverOne(files).read();
    assert.deepEqual([reading.packageTempC, reading.throttlePointC, reading.coreTemps],
        [70, null, []]);
});

// `thermal_throttle_attrs[]` carries `core_throttle_max_time_ms` beside the two
// counters, and `thermal_throttle_add_dev()` adds `package_throttle_max_time_ms`
// with the package counter for any CPU with X86_FEATURE_PTS.
test('the lifetime worst is read for both levels', () => {
    const files = {};
    for (const cpu of [0, 1]) {
        Object.assign(files, filesIn(`${CPU_ROOT}/cpu${cpu}/thermal_throttle`, {
            [COUNTER]: '4', [TOTAL_MS]: '900',
            core_throttle_max_time_ms: String(500 + cpu),
            package_throttle_count: '2',
            package_throttle_max_time_ms: String(7000 + cpu),
        }));
    }
    const reading = discoverOne(files).read();
    assert.deepEqual(reading.cores,
        [[counters(4, 900, 500)], [counters(4, 900, 501)]]);
    assert.deepEqual(reading.packageMaxMs, [7000, 7001]);
});

// Pre-Haswell, or a kernel without X86_FEATURE_PTS: absent reads as null, which
// the rule skips rather than reporting as a zero-length worst episode.
test('a kernel publishing neither figure reports null, not zero', () => {
    const reading = discoverOne(cores([3, 4])).read();
    assert.deepEqual(reading.cores.flat().map(c => c.maxMs), [null, null]);
    assert.deepEqual(reading.packageMaxMs, [null, null]);
});

// `create_core_attrs()` builds `_max` from the same `temp_data` as `_input` and
// `_crit`, so ttarget belongs to the channel that published it. It exists only
// where `get_ttarget()` succeeded, which is only where TjMax itself came from
// MSR_IA32_TEMPERATURE_TARGET rather than from the model table.
test('the thermal target is read per channel, package and core alike', () => {
    const files = {
        ...cores([0]),
        ...coretemp(60_000),
        ...coretemp(94_000, {label: 'Core 0', index: 2}),
    };
    files['/sys/class/hwmon/hwmon2/temp1_max'] = '97000';
    files['/sys/class/hwmon/hwmon2/temp2_max'] = '95000';

    const reading = discoverOne(files).read();
    assert.equal(reading.targetC, 97);
    assert.deepEqual(reading.coreTemps,
        [{label: 'Core 0', tempC: 94, throttlePointC: 100, targetC: 95}]);
});

test('an Atom or pre-Core part, which publishes none, reads null', () => {
    const reading = discoverOne({...cores([0]), ...coretemp(60_000)}).read();
    assert.equal(reading.targetC, null);
});
