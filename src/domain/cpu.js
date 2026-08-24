// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// CPU throttle rules.
//
// The headline signal is the number of cores that entered a thermal throttle
// since the previous poll.  Only the chip itself sets that bit, which makes it
// proof rather than inference — one of the two signals in this extension that
// earn CONFIRMED (the other is the GPU drivers' PROCHOT reason flag; see
// src/domain/gpu.js).
//
// What the bit is, and what it is not
// -----------------------------------
// `therm_throt.c` feeds this counter from `msr_val & THERM_STATUS_PROCHOT`,
// and `msr-index.h` defines that as bit 0 of `IA32_THERM_STATUS`.  The name is
// a long-standing kernel misnomer: in the SDM, bit 0 is **Thermal Status** —
// the core is at or above its Thermal Control Circuit activation temperature —
// while the external PROCHOT#/FORCEPR# pin event is a different bit entirely.
// (The kernel's own `THERM_STATUS_PROCHOT_LOG` on bit 1 is the SDM's "Thermal
// Status Log", which corroborates the layout.)
//
// This is better for us than the name suggested, and the wording says so.  An
// external PROCHOT# assertion can come from a voltage regulator or a battery
// current limit and need not be thermal at all; TCC activation is nothing but
// thermal.  So the user-visible word here is "thermal (TCC)".  The GPU rule
// keeps saying PROCHOT, because there the flag really is the GPU observing the
// package PROCHOT signal — the same word, two different facts, and this
// extension exists to not blur that kind of line.
//
// Which counter, and why it matters
// ---------------------------------
// `thermal_throttle/` exposes two numbers per logical CPU, and they move at
// opposite ends of an episode.  From `therm_throt.c:therm_throt_process()`:
//
//   core_throttle_count         `state->count++` on the *assert* interrupt.
//                               An episode has begun.
//   core_throttle_total_time_ms `state->total_time_ms += …`, written only in
//                               the de-assert branch.  An episode has ended.
//
// So `count` answers "did a thermal assert happen since the previous poll", and
// `total_time_ms` answers "how much of that interval was spent throttled".
// Reading only the latter — as this extension first did — reports a throttle
// once it is already over, and reports nothing at all during a long one, when
// the accumulator sits still for minutes.
//
// Neither is a "throttling right now" flag, and there is no sysfs attribute that
// is.  `count` moves on the assert interrupt and nothing re-increments it while
// the status bit stays asserted (`throttle_active_work` polls temperature and
// clears the log bit, but never touches `state->count`).  A perfectly steady
// assertion would therefore advance neither counter and fall through to the
// temperature verdict.  In practice TCC toggles far faster than any poll
// interval, and the 30-second linger covers the rest — but the claim this
// extension can honestly make is about the interval, not the instant.
//
// Both are used: `count` decides the verdict, `total_time_ms` says how long the
// episode that just ended ran for, when one did.
//
// The two are deliberately not paired.  `state->count++` runs unconditionally
// on the assert, but the kernel then reads the thermal status and returns early
// — before setting `last_interrupt_time` — when the temperature is more than
// 10 °C below the trip point, dismissing it as a "short temperature spike".
// The de-assert branch is guarded on `last_interrupt_time`, so such an episode
// contributes nothing to `total_time_ms`, ever.  An increment with no matching
// duration is therefore normal, and the two must stay independent: pairing them
// would drop those episodes from the verdict entirely.
//
// One more thing this counter is not: `therm_throt.c` routes the power-limit
// bit (`THERM_STATUS_POWER_LIMIT`) to a separate `core_power_limit` state that
// has no sysfs attribute at all.  `core_throttle_count` moves only for
// `THERM_STATUS_PROCHOT` at CORE_LEVEL, so — unlike the GPU's `throttle/status`
// — it cannot be raised by a machine merely hitting its power budget.
//
// The package counter
// -------------------
// `therm_throt.c` publishes `package_throttle_count` in the same directory on
// every CPU with `X86_FEATURE_PTS`, fed from `MSR_IA32_PACKAGE_THERM_STATUS` —
// the package's own TCC activation.  It is the same grade of evidence as the
// core counter and catches a package trip that no individual core's sensor
// reached, which would otherwise fall through to the temperature verdict.
//
// It is counted differently, and must be.  Each CPU holds a *copy* of one
// package-scope event, so summing them would report "16 of 8".  And with
// `X86_FEATURE_DPTI` the kernel directs the package interrupt to a single
// unpredictable CPU per package, so only that copy moves — the question is
// therefore "did any CPU's package counter advance", never "how many".
//
// When no counter moved, the verdict falls back to the temperature tier — how
// much headroom is left below the hardware's own trip point, and what the user
// asked to be warned about — which can never exceed HIGH.  A CPU that has no
// per-core counter at all (AMD's k10temp) simply reports an empty core array and
// rides that fallback — the honest answer for hardware that cannot prove it.

import {Confidence} from './confidence.js';
import {assessHeadroom, tightestSensor} from './temperature.js';

/**
 * A throttle episode's length, in the units a person would use for it.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

/**
 * @typedef {object} CpuCounters
 * @property {number|null} episodes   `core_throttle_count`, or null if unreadable.
 * @property {number|null} totalMs    `core_throttle_total_time_ms`, or null.
 * @property {number|null} [maxMs]    `core_throttle_max_time_ms`, or null.
 *   A lifetime figure, not a delta: the longest single episode since boot.
 *
 * @typedef {object} CpuReading
 * @property {CpuCounters[][]} cores
 *   One entry per physical core, each holding that core's counters — one per
 *   logical CPU that reports them, indexed consistently across polls.
 * @property {number|null} [throttlePointC]
 *   The temperature at which this CPU's hardware throttles — TjMax on coretemp,
 *   the HTC trip on k10temp. Absent where the driver does not publish one.
 * @property {{label: string|null, tempC: number|null, throttlePointC: number|null,
 *             targetC: number|null}[]} [coreTemps]
 *   One entry per core sensor the driver publishes, each with its own trip
 *   point. Absent where there are none — the thermal-zone fallback, and AMD,
 *   whose per-CCD channels carry no trip point to measure against.
 * @property {number|null} [targetC]
 *   The package sensor's `tempN_max` — ttarget, the temperature the platform
 *   actively tries to hold below. Null where the part publishes none.
 * @property {(number|null)[]} [packageMaxMs]
 *   `package_throttle_max_time_ms` per logical CPU — the package's own lifetime
 *   worst, copies of one figure exactly as the counter beside it is.
 * @property {(number|null)[]} [packageEpisodes]
 *   `package_throttle_count` as each logical CPU reports it — copies of one
 *   package-scope event, so this is asked "did any advance", never "how many".
 *   Absent on hardware with no package sensor.
 * @property {number|null} packageTempC
 */

/**
 * Did this pair of readings, from one logical CPU, show the counter advance?
 *
 * @param {number|null} now
 * @param {number|null} before
 * @returns {boolean}
 */
const advanced = (now, before) => now !== null && before !== null && now > before;

/**
 * Compare one core's CPUs with their own previous values.
 *
 * Each CPU is compared with *its own* reading and never with a sibling's.  The
 * kernel keeps these counters per logical CPU, so siblings of one core drift
 * apart across an offline/online cycle; letting one stand in for another would
 * read that drift as a throttle event — and this is the signal the whole
 * extension treats as proof.
 *
 * A counter that went backwards (suspend/resume, a hotplug cycle) is not an
 * event either, and a change in how many CPUs the core reports means the set
 * was re-read, so no delta from it can be trusted.
 *
 * @param {CpuCounters[]} current
 * @param {CpuCounters[]|null|undefined} previous
 * @returns {{began: boolean, endedMs: number}}
 *   `began` if any CPU entered a throttle; `endedMs` is how much throttled time
 *   the busiest CPU banked during this interval, or 0 if none did.  Not one
 *   episode's length: `total_time_ms` is an accumulator, so a poll that spans
 *   several short episodes reports their sum.  See `assessCpu`.
 */
function coreDelta(current, previous) {
    if (!previous || current.length !== previous.length) return {began: false, endedMs: 0};

    let began = false;
    let endedMs = 0;
    for (let i = 0; i < current.length; i++) {
        if (advanced(current[i].episodes, previous[i].episodes)) began = true;
        if (advanced(current[i].totalMs, previous[i].totalMs))
            endedMs = Math.max(endedMs, current[i].totalMs - previous[i].totalMs);
    }
    return {began, endedMs};
}

/**
 * @param {CpuCounters[][]} current
 * @param {CpuCounters[][]|null|undefined} previous
 * @returns {{cores: number, endedMs: number}}
 *   How many cores threw a throttle, and the most throttled time any one of
 *   them banked over the interval.
 */
function throttlingCores(current, previous) {
    if (!previous || current.length !== previous.length) return {cores: 0, endedMs: 0};

    let cores = 0;
    let endedMs = 0;
    for (let i = 0; i < current.length; i++) {
        const {began, endedMs: ended} = coreDelta(current[i], previous[i]);
        if (began) cores++;
        endedMs = Math.max(endedMs, ended);
    }
    return {cores, endedMs};
}

/**
 * Did the package itself throttle?
 *
 * Every CPU carries a copy of the same package-scope counter, and with directed
 * package interrupts only one of them is updated — so this is a disjunction over
 * the copies, not a count of them.  Each copy is compared with its own history
 * for the same reason the core counters are: they are separate accumulators and
 * a value that switched source would read as a jump.
 *
 * @param {(number|null)[]|undefined} current
 * @param {(number|null)[]|undefined} previous
 * @returns {boolean}
 */
function packageThrottled(current, previous) {
    if (!current || !previous || current.length !== previous.length) return false;
    return current.some((episodes, i) => advanced(episodes, previous[i]));
}

/**
 * The longest single throttle episode this CPU has recorded since boot.
 *
 * `therm_throt.c` keeps `max_time_ms` beside `total_time_ms` and writes both in
 * the same de-assert branch, so it inherits that counter's one bias: an assert
 * the kernel dismissed as a spike — more than 10 °C below the trip point —
 * never sets `last_interrupt_time` and so contributes no duration at all. What
 * it records is therefore the worst *sustained* episode, which is the one worth
 * knowing about.
 *
 * Core and package figures are pooled deliberately. They are two levels of the
 * same event and the question here is neither "which" nor "how many" but simply
 * how long the worst one lasted; taking the larger is the only answer that does
 * not depend on which level happened to catch it. An offline CPU's attributes
 * return an empty string, which the port's strict parser reports as null rather
 * than as zero, so a parked CPU cannot drag the maximum down.
 *
 * @param {CpuReading} reading
 * @returns {number} Milliseconds, or 0 when nothing has been recorded.
 */
function worstEpisodeMs({cores, packageMaxMs}) {
    const recorded = [
        ...cores.flat().map(counters => counters.maxMs),
        ...packageMaxMs ?? [],
    ].filter(ms => typeof ms === 'number' && ms > 0);

    return recorded.length > 0 ? Math.max(...recorded) : 0;
}

/**
 * A confirmed throttle, with the machine's worst episode beside it where one is
 * on record.
 *
 * Only beside a confirmed throttle, and that is the whole of the wording
 * problem. `max_time_ms` is a lifetime figure: on screen while nothing is
 * happening it would read as current state, and a machine that throttled badly
 * three suspends ago would look like a machine throttling now. Next to a
 * throttle the user is already being told about, it answers the question that
 * throttle raises — is this a blip or is the cooling losing? — and answers it
 * about the same hardware, in the same breath.
 *
 * @param {string} summary
 * @param {string} detail
 * @param {number} worstMs
 * @param {{throttlingCount?: number}} [extra]  Merged in last, for the one
 *   caller that can honestly say how many units are throttling.
 * @returns {import('./monitor.js').Verdict}
 */
function confirmed(summary, detail, worstMs, extra = {}) {
    return {
        level: Confidence.CONFIRMED,
        summary,
        detail: worstMs > 0
            ? `${detail}; longest episode since boot ${formatDuration(worstMs)}`
            : detail,
        ...extra,
    };
}

/**
 * @param {CpuReading|null} reading
 * @param {CpuReading|null|undefined} previous
 * @param {import('./monitor.js').Context} context
 * @returns {import('./monitor.js').Verdict}
 */
export function assessCpu(reading, previous, {thresholds}) {
    if (!reading)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: ''};

    const {packageTempC: tempC} = reading;
    const summary = tempC !== null ? `${tempC}°C` : '?°C';
    const total = reading.cores.length;
    const {cores, endedMs} = throttlingCores(reading.cores, previous?.cores);

    const worstMs = worstEpisodeMs(reading);

    if (cores > 0)
        return confirmed(summary, `${cores} of ${total} cores throttling — thermal (TCC)`,
            worstMs, {throttlingCount: cores});

    // No individual core's sensor tripped, but the package's did.  Same grade of
    // evidence, one event rather than a count — so no panel suffix, because
    // there is no honest number to put in it.
    if (packageThrottled(reading.packageEpisodes, previous?.packageEpisodes))
        return confirmed(summary, 'CPU package throttling — thermal (TCC)', worstMs);

    // No core entered a throttle, but one banked throttled time: it was
    // throttling until a moment ago, and saying "nominal" now would be as wrong
    // as the other way round.
    //
    // The wording is careful. `total_time_ms` is an accumulator that the kernel
    // advances at the de-assert, so this is *how much of the interval the worst
    // core spent throttled* — under a sustained load that toggles TCC many
    // times a second, it is the sum of a great many short episodes, not the
    // length of one. Calling it "throttled for 6 s" would invent a single
    // six-second episode that never happened.
    if (endedMs > 0)
        return confirmed(summary,
            `${formatDuration(endedMs)} throttled since the last poll — thermal (TCC)`, worstMs);

    // Nothing readable anywhere: no package sensor, and no core channel either.
    // A machine whose package `_input` failed while its cores answered is rare —
    // `create_core_attrs()` builds both — but the cores are still evidence, and
    // discarding them would report UNKNOWN beside a core at its trip point. The
    // panel shows `?°C` in that case, and the popup line says which core spoke.
    const tightest = tightestSensor([
        // The package channel carries a null label: its reading is the number
        // already on the panel, so the wording has no need to attribute it.
        {
            label: null,
            tempC: reading.packageTempC,
            throttlePointC: reading.throttlePointC ?? null,
            targetC: reading.targetC ?? null,
        },
        ...reading.coreTemps ?? [],
    ]);
    if (tempC === null && tightest === null)
        return {level: Confidence.UNKNOWN, summary, detail: 'Temperature unreadable'};

    // No counter moved, so the verdict is the temperature tier's: headroom below
    // the hardware's own trip point, and whatever the user asked to be told.
    // The panel temperature is what the preference judges — "tell me at 88°C" is
    // a statement about the figure on screen, and applying it to a sensor the
    // user cannot see would turn the indicator amber with no visible cause.
    const {level, clauses} = assessHeadroom(tightest, tempC, thresholds);
    return {level, summary, detail: clauses.join(' — ') || 'Nominal'};
}
