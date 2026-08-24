// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel CPU adapter (coretemp / thermal_throttle).
//
// Two sysfs sources, both world-readable:
//
//   thermal_throttle/core_throttle_count          episodes entered
//   thermal_throttle/core_throttle_total_time_ms  milliseconds accumulated
//     Both published per logical CPU but properties of the physical core, and
//     they move at opposite ends of an episode — see src/domain/cpu.js for why
//     both are read.  Present from Haswell onwards.
//   thermal_throttle/core_throttle_max_time_ms    longest single episode
//     A lifetime figure rather than a delta, so it answers a different question
//     from the other two: not "is it throttling" but "how bad has it ever got".
//     The package group carries its own counterpart.
//   thermal_throttle/package_throttle_count       package TCC events
//     The package-level counterpart, added by `thermal_throttle_add_dev()` for
//     any CPU with X86_FEATURE_PTS.  Every CPU holds a copy of one package-scope
//     event, so the rule asks whether any advanced — see src/domain/cpu.js.
//   Package temperature          coretemp's "Package id 0" hwmon input,
//     falling back to the x86_pkg_temp thermal zone.
//   Throttle point               the same channel's `_crit`, which coretemp
//     fills with TjMax — the temperature at which the thermal control circuit
//     engages.  Absent on the thermal-zone fallback path.
//   Per-core temperatures        the "Core N" channels of that same coretemp
//     device, each with its own `_crit`.  TCC activation is a per-core event and
//     a core can sit several degrees above the package sensor, so headroom is
//     measured on every channel and the tightest one answers.
//   Thermal target               `tempN_max`, which coretemp fills with ttarget:
//     the temperature the platform actively tries to hold below, TjMax minus the
//     offset in bits 8:15 of `MSR_IA32_TEMPERATURE_TARGET`.  Absent on Atoms and
//     pre-Core parts, and — because `get_ttarget()` returns -ENODEV when
//     `tdata->tjmax` is already set — absent on any part whose TjMax the kernel
//     had to guess at.  So where it exists, both it and `_crit` came from the
//     MSR and neither is a model-table fallback.
//
// Either source alone is enough to be useful, so discovery succeeds if it finds
// one.  The package temperature is offered to the Monitor as the shared
// `packageTempC` that the GPU and NPU rules reason against.

import {assessCpu} from '../domain/cpu.js';
import {degreesAt, devicesNamed, temperatureChannels} from './hwmon.js';

const CPU_ROOT = '/sys/devices/system/cpu';
const THERMAL_ROOT = '/sys/class/thermal';

const THROTTLE_COUNT = 'core_throttle_count';
const THROTTLE_TOTAL_MS = 'core_throttle_total_time_ms';
// The third number in the same group: the longest single high-to-low episode
// since boot, written in the same de-assert branch as the total.
const THROTTLE_MAX_MS = 'core_throttle_max_time_ms';
// Present alongside the core counters on every CPU with X86_FEATURE_PTS, which
// is every Intel part this extension targets. Absent otherwise; reads as null.
const PACKAGE_THROTTLE_COUNT = 'package_throttle_count';
const PACKAGE_THROTTLE_MAX_MS = 'package_throttle_max_time_ms';
const PACKAGE_LABEL = 'Package id 0';
// `create_core_attrs()` labels a core channel "Core N", where N is the core id.
const CORE_LABEL = /^Core \d+$/;

/**
 * The counter directories, grouped by *physical* core.
 *
 * sysfs exposes `thermal_throttle` per logical CPU, but the thermal event is a
 * property of the core: on an SMT part both siblings' counters advance together.
 * Counting the directories would report "2 of 16 cores throttling" on an
 * 8-core chip where one core throttled — double the truth, against double the
 * total. So the siblings of a core become one group, and the rule asks whether
 * anything in that group moved.
 *
 * Every sibling is kept, and kept separate. Picking one as the core's
 * representative would leave that core blind to a throttle if it were later
 * offlined; collapsing them to a single number would let the reported value
 * switch source between polls, and these accumulators are per logical CPU, so
 * a switch reads as a jump — which the rule takes as proof of a throttle.
 *
 * Topology is read per CPU and either every eligible CPU has it or none is
 * grouped at all. A partial grouping would mix cores and threads in one list,
 * so "N of M cores" would be counting two different things at once.
 *
 * This runs once, at enable(). The list is deliberately fixed for the session:
 * the rule compares each poll with the one before it, and a list that grew or
 * shrank underneath that comparison would have no trustworthy delta. A CPU
 * offlined at enable() therefore stays out until the extension is reloaded, and
 * the "of M" denominator never moves.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {string[][]} One group of sibling directories per physical core.
 */
function findCoreThrottleGroups(sysfs) {
    const cpus = [];
    for (const entry of sysfs.list(CPU_ROOT)) {
        if (!/^cpu\d+$/.test(entry)) continue;
        const cpu = `${CPU_ROOT}/${entry}`;
        const dir = `${cpu}/thermal_throttle`;
        if (sysfs.readText(`${dir}/${THROTTLE_COUNT}`) === null) continue;

        // The kernel already publishes this grouping, so take it rather than
        // rebuild it. `core_cpus_list` is documented as "human-readable list of
        // CPUs within the same core", rendered from one cpumask — so both
        // siblings of a core emit the identical string ("0-1"), and the string
        // itself is the key. No parsing: two CPUs are in the same core exactly
        // when the kernel gives them the same answer.
        //
        // This replaced a key composed from `physical_package_id`, `die_id` and
        // `core_id`, all three of which the ABI documentation calls
        // platform-dependent identifiers, and which needed a default for the
        // `die_id` older kernels do not publish — without it two cores on
        // different dies of one package sharing a `core_id` merged into one
        // group and under-counted the "of M" denominator.
        //
        // `thread_siblings_list` is the same file's deprecated name, kept for
        // kernels older than the rename in 5.3.
        cpus.push({
            dir,
            key: sysfs.readText(`${cpu}/topology/core_cpus_list`)
                ?? sysfs.readText(`${cpu}/topology/thread_siblings_list`),
        });
    }

    // All or nothing: one CPU without topology means the whole list stays in
    // threads rather than becoming a mixture.
    if (cpus.some(cpu => cpu.key === null))
        return cpus.map(cpu => [cpu.dir]);

    const byCore = new Map();
    for (const {dir, key} of cpus) {
        if (!byCore.has(key)) byCore.set(key, []);
        byCore.get(key).push(dir);
    }
    return [...byCore.values()];
}

/**
 * coretemp's channels: the hwmon whose `name` is `coretemp` and whose labels
 * read "Package id 0" and "Core N".
 *
 * Returns each channel's prefix — `…/hwmon2/temp1` — rather than one attribute,
 * because two of them matter. `_input` is the temperature; `_crit` is TjMax,
 * the temperature at which this part's thermal control circuit engages. That
 * second number is the whole reason a temperature means anything: `coretemp.c`
 * computes `_input` as `tjmax - digital_readout`, so `_crit - _input` recovers
 * the digital readout exactly — the hardware's own count of degrees remaining
 * before it throttles.
 *
 * `create_core_attrs()` builds `_crit` for every sensor it creates
 * (`attr_size = MAX_CORE_ATTRS` includes it unconditionally), so a machine with
 * a coretemp package sensor has it.
 *
 * The headroom survives a TjMax the kernel had to guess at. `get_tjmax()` reads
 * `MSR_IA32_TEMPERATURE_TARGET` where it can and falls back to a model table or
 * a flat 100 °C where it cannot — but `show_temp()` subtracts the *same* value,
 * so the difference is the digital readout either way. A wrong TjMax moves both
 * numbers together: the absolute temperature and the trip point shown in the
 * popup are off by the same amount, and the distance between them, which is
 * what the verdict turns on, is exact.
 *
 * Both facts hold per core as well as per package: `create_core_attrs()` is the
 * same function for both kinds of sensor, so every "Core N" channel carries its
 * own `_input` and `_crit`. That matters because TCC activation is a per-core
 * event — a single core can sit several degrees above the package sensor, and
 * measuring headroom on the package alone would call that machine nominal right
 * up until its counter moved.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {{package: string, cores: {label: string|null, channel: string}[]}|null}
 */
function findCoretempChannels(sysfs) {
    for (const device of devicesNamed(sysfs, 'coretemp')) {
        const channels = temperatureChannels(sysfs, device);
        const package_ = channels.find(({label}) => label === PACKAGE_LABEL);
        // The core channels come from the same device as the package channel,
        // not from every coretemp device on the machine. On a two-socket board
        // there is one device per package, each labelling its cores from zero —
        // and a temperature from one socket beside a package reading from the
        // other describes no hardware.
        if (package_)
            return {
                package: package_.channel,
                cores: channels.filter(({label}) => CORE_LABEL.test(label ?? '')),
            };
    }
    return null;
}

/**
 * Fallback for systems where coretemp is absent but the thermal framework
 * still publishes the package zone.  The zone index is platform-specific, so
 * match on `type` rather than guessing a number.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {string|null}
 */
function findPackageThermalZone(sysfs) {
    for (const entry of sysfs.list(THERMAL_ROOT)) {
        if (!/^thermal_zone\d+$/.test(entry)) continue;
        const zone = `${THERMAL_ROOT}/${entry}`;
        if (sysfs.readText(`${zone}/type`) === 'x86_pkg_temp') return `${zone}/temp`;
    }
    return null;
}


/**
 * One temperature channel's three numbers, kept together.
 *
 * `create_core_attrs()` builds `_input`, `_crit` and — where the part has one —
 * `_max` from the same `temp_data`, so they describe one sensor. Splitting them
 * across channels is the one arithmetic this rule must never do.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string|null} label
 * @param {string} channel  Attribute prefix, e.g. `…/hwmon2/temp2`.
 * @returns {{label: string|null, tempC: number|null,
 *            throttlePointC: number|null, targetC: number|null}}
 */
const sensorAt = (sysfs, label, channel) => ({
    label,
    tempC: degreesAt(sysfs, `${channel}_input`),
    throttlePointC: degreesAt(sysfs, `${channel}_crit`),
    targetC: degreesAt(sysfs, `${channel}_max`),
});

/**
 * Every sibling's counter, kept separate.
 *
 * Collapsing a core's siblings to one number here — the first readable, say —
 * would mean the reported value could switch source between polls, and the
 * accumulators are per logical CPU: they drift apart across an offline/online
 * cycle.  A switch would then look like a jump, and the rule reads any increase
 * as a confirmed throttle.  Keeping them apart lets the rule compare each CPU
 * with its own history.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {{coreGroups: string[][], cpuDirs: string[], temperaturePath: string|null,
 *          throttlePointPath: string|null,
 *          coreChannels: {label: string|null, channel: string}[]}} hardware
 * @returns {import('../domain/cpu.js').CpuReading}
 */
function read(sysfs, {coreGroups, cpuDirs, temperaturePath, throttlePointPath, targetPath,
    coreChannels}) {
    return {
        cores: coreGroups.map(siblings => siblings.map(dir => ({
            episodes: sysfs.readInt(`${dir}/${THROTTLE_COUNT}`),
            totalMs: sysfs.readInt(`${dir}/${THROTTLE_TOTAL_MS}`),
            maxMs: sysfs.readInt(`${dir}/${THROTTLE_MAX_MS}`),
        }))),
        // Flat, and in the order discovery fixed: these are per-CPU copies of a
        // package-scope event, not a per-core signal, so grouping them by core
        // would invite the rule to count them.
        packageEpisodes: cpuDirs.map(dir => sysfs.readInt(`${dir}/${PACKAGE_THROTTLE_COUNT}`)),
        // The package's own lifetime worst, added to the same group by
        // `thermal_throttle_add_dev()` beside the counter above.
        packageMaxMs: cpuDirs.map(dir => sysfs.readInt(`${dir}/${PACKAGE_THROTTLE_MAX_MS}`)),
        packageTempC: degreesAt(sysfs, temperaturePath),
        // Re-read every poll rather than cached at discovery: it is one more
        // read of a value the driver holds in memory, and a cached number that
        // silently stopped matching the hardware is the more expensive mistake.
        throttlePointC: degreesAt(sysfs, throttlePointPath),
        targetC: degreesAt(sysfs, targetPath),
        // Each core's own sensor and its own TjMax, kept paired: the headroom
        // between them is the hardware's count of degrees remaining, and mixing
        // channels would compute a distance between two different sensors.
        coreTemps: coreChannels.map(({label, channel}) => sensorAt(sysfs, label, channel)),
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'Intel CPU',
    category: 'cpu',

    discover(sysfs) {
        const coreGroups = findCoreThrottleGroups(sysfs);
        const coretemp = findCoretempChannels(sysfs);
        // The thermal-zone fallback reports a temperature and nothing else:
        // `x86_pkg_temp`'s trip points are the programmable thresholds, not
        // TjMax, so a machine on that path has no throttle point to offer, and
        // no per-core channels either.
        const temperaturePath = coretemp !== null
            ? `${coretemp.package}_input`
            : findPackageThermalZone(sysfs);
        const throttlePointPath = coretemp !== null ? `${coretemp.package}_crit` : null;
        const targetPath = coretemp !== null ? `${coretemp.package}_max` : null;
        if (coreGroups.length === 0 && temperaturePath === null) return [];

        // The package attributes live in the same sysfs group as the core ones
        // and are created with them, so the CPUs that offered a core counter are
        // exactly the CPUs that can offer a package one.
        const hardware = {
            coreGroups,
            cpuDirs: coreGroups.flat(),
            temperaturePath,
            throttlePointPath,
            targetPath,
            coreChannels: coretemp?.cores ?? [],
        };
        return [{
            id: 'cpu:intel',
            title: 'CPU',
            read: () => read(sysfs, hardware),
            assess: assessCpu,
            temperatureC: reading => reading?.packageTempC ?? null,
            // Offered beside the temperature so the rules can measure headroom
            // rather than compare against an absolute number that means
            // something different on every part.
            throttlePointC: reading => reading?.throttlePointC ?? null,
        }];
    },
};
