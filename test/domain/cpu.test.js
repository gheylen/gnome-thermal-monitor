// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {assessCpu} from '../../src/domain/cpu.js';
import {Thresholds} from '../../src/domain/thresholds.js';

const context = {packageTempC: null, thresholds: new Thresholds(88, 94)};

/**
 * One logical CPU's pair of counters. A bare number is the episode count, which
 * is what nearly every test here is about; `{episodes, totalMs}` spells out both.
 *
 * @param {number|null|{episodes?: number|null, totalMs?: number|null}} value
 */
const cpu = value => typeof value === 'object' && value !== null
    ? {episodes: null, totalMs: null, ...value}
    : {episodes: value, totalMs: 0};

/**
 * A reading from single-threaded cores: one logical CPU each.
 * `reading([150, 100])` is two cores whose episode counts read 150 and 100.
 */
const reading = (counters, packageTempC = 60) =>
    ({cores: counters.map(value => [cpu(value)]), packageTempC});

/** A reading from SMT cores: `smt([[10, 20], [30, 40]])` is two cores of two CPUs. */
const smt = (cores, packageTempC = 60) =>
    ({cores: cores.map(siblings => siblings.map(cpu)), packageTempC});

test('no reading at all → UNKNOWN', () => {
    assert.equal(assessCpu(null, null, context).level, Confidence.UNKNOWN);
});

test('cores that entered a throttle are CONFIRMED and counted', () => {
    const verdict = assessCpu(reading([150, 100, 200, 100]), reading([100, 100, 100, 100]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /2 of 4 cores throttling — thermal \(TCC\)/);
    assert.equal(verdict.throttlingCount, 2);
});

test('all cores throttling reports N of N', () => {
    const verdict = assessCpu(reading([5, 5, 5, 5]), reading([0, 0, 0, 0]), context);
    assert.match(verdict.detail, /4 of 4 cores throttling/);
});

test('a counter that went backwards is a reset, not an event', () => {
    const verdict = assessCpu(reading([50, 150]), reading([100, 100]), context);
    assert.match(verdict.detail, /1 of 2 cores throttling/);
});

test('an unreadable core this poll is skipped, not guessed at', () => {
    const verdict = assessCpu(reading([null, 150]), reading([100, 100]), context);
    assert.match(verdict.detail, /1 of 2 cores throttling/);
});

test('an unreadable core last poll is skipped too', () => {
    const verdict = assessCpu(reading([150, 150]), reading([null, 100]), context);
    assert.match(verdict.detail, /1 of 2 cores throttling/);
});

test('the first poll has nothing to diff and falls to temperature', () => {
    const verdict = assessCpu(reading([100, 100], 60), undefined, context);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.detail, 'Nominal');
});

test('a change in core count makes the delta untrustworthy, so it is not used', () => {
    // The overlapping cores here *have* advanced, so comparing by index would
    // report two throttling cores. A core set that changed size between polls
    // is not the same set, and none of those pairings can be trusted.
    const verdict = assessCpu(reading([50, 50, 50], 60), reading([10, 10]), context);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.detail, 'Nominal');

    // And the same in the other direction.
    assert.equal(assessCpu(reading([50, 50], 60), reading([10, 10, 10]), context).level,
        Confidence.LOW);
});

test('temperature drives the verdict when no core throttled', () => {
    const previous = reading([10, 10]);
    assert.equal(assessCpu(reading([10, 10], 95), previous, context).level, Confidence.HIGH);
    assert.equal(assessCpu(reading([10, 10], 94), previous, context).level, Confidence.HIGH);
    assert.equal(assessCpu(reading([10, 10], 90), previous, context).level, Confidence.MEDIUM);
    assert.equal(assessCpu(reading([10, 10], 88), previous, context).level, Confidence.MEDIUM);
    assert.equal(assessCpu(reading([10, 10], 87), previous, context).level, Confidence.LOW);
});

test('an unreadable temperature is reported as unknown, never as "nominal"', () => {
    const verdict = assessCpu(reading([10, 10], null), reading([10, 10]), context);
    assert.equal(verdict.level, Confidence.UNKNOWN);
    assert.equal(verdict.summary, '?°C');
    assert.match(verdict.detail, /unreadable/i);
});

test('a confirmed throttle stands even when the temperature is unreadable', () => {
    const verdict = assessCpu(reading([50, 10], null), reading([10, 10]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
});

test('only the throttling verdict carries a panel suffix', () => {
    assert.equal(assessCpu(reading([10, 10], 95), reading([10, 10]), context).throttlingCount, undefined);
});

// AMD's adapter feeds an empty core array; CONFIRMED must be unreachable.
// Each logical CPU is compared with its own history, never with a sibling's:
// the kernel keeps this accumulator per CPU, so siblings drift apart across a
// hotplug, and treating one as a stand-in for another reads that drift as proof
// of a throttle — the strongest claim this extension makes.
test('a core throttled when any one of its own CPUs advanced', () => {
    const verdict = assessCpu(smt([[10, 99], [10, 10]]), smt([[10, 10], [10, 10]]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /1 of 2 cores throttling/);
});

test('a core counts once however many of its CPUs advanced', () => {
    const verdict = assessCpu(smt([[99, 99], [10, 10]]), smt([[10, 10], [10, 10]]), context);
    assert.match(verdict.detail, /1 of 2 cores throttling/);
});

test('siblings that merely disagree are not a throttle', () => {
    // cpu0 reads 100 and its sibling 5000 — normal after a hotplug cycle, and
    // no evidence of anything. Neither moved since the last poll.
    const drifted = smt([[100, 5000]]);
    assert.equal(assessCpu(drifted, drifted, context).level, Confidence.LOW);
});

test('a CPU going unreadable is not a throttle, whatever its sibling reads', () => {
    // The exact shape that produced a false "1 of 1 cores throttling — PROCHOT"
    // and a desktop notification: cpu0 offlined while its sibling read higher.
    const verdict = assessCpu(smt([[null, 5000]]), smt([[100, 5000]]), context);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.detail, 'Nominal');
});

test('a CPU coming back with a reset counter is not a throttle either', () => {
    const verdict = assessCpu(smt([[0, 5000]]), smt([[null, 5000]]), context);
    assert.equal(verdict.level, Confidence.LOW);
});

test('a core whose CPU count changed between polls yields no delta', () => {
    // The overlapping CPU *has* advanced, so comparing by index would report a
    // throttle. A core reporting a different number of CPUs is not the same set,
    // and none of those pairings can be trusted.
    assert.equal(assessCpu(smt([[99, 99]]), smt([[10]]), context).level, Confidence.LOW);
    assert.equal(assessCpu(smt([[99]]), smt([[10, 10]]), context).level, Confidence.LOW);
});

test('a CPU with no per-core counter can never reach CONFIRMED', () => {
    const previous = reading([]);
    assert.equal(assessCpu(reading([], 95), previous, context).level, Confidence.HIGH);
    assert.equal(assessCpu(reading([], 90), previous, context).level, Confidence.MEDIUM);
    assert.equal(assessCpu(reading([], 60), previous, context).level, Confidence.LOW);
});

// ── Which counter, and when ────────────────────────────────────────────────
//
// `thermal_throttle/` exposes two numbers per logical CPU and they move at
// opposite ends of an episode: `core_throttle_count` on the assert interrupt,
// `core_throttle_total_time_ms` on the de-assert. Reading only the accumulator
// — as this rule first did — reports a throttle once it is over, and reports
// nothing at all while a long one is in progress.

test('a rising episode count is a throttle beginning', () => {
    const verdict = assessCpu(
        smt([[{episodes: 4, totalMs: 900}]]),
        smt([[{episodes: 3, totalMs: 900}]]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /1 of 1 cores throttling — thermal \(TCC\)/);
    assert.equal(verdict.throttlingCount, 1);
});

test('a sustained throttle is still reported while the accumulator sits still', () => {
    // The kernel writes total_time_ms only when the episode ends, so during a
    // long one it does not move. The count moved when it started, and the
    // linger carries the panel from there.
    const started = assessCpu(
        smt([[{episodes: 4, totalMs: 0}]], 91),
        smt([[{episodes: 3, totalMs: 0}]], 91), context);
    assert.equal(started.level, Confidence.CONFIRMED);
});

test('an episode ending is reported, with how long it ran', () => {
    const verdict = assessCpu(
        smt([[{episodes: 4, totalMs: 3400}]]),
        smt([[{episodes: 4, totalMs: 900}]]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.equal(verdict.detail, '2.5 s throttled since the last poll — thermal (TCC)');
    assert.equal(verdict.throttlingCount, undefined, 'no core is throttling right now');
});

test('a core count takes precedence over a duration when both moved', () => {
    const verdict = assessCpu(
        smt([[{episodes: 4, totalMs: 3400}]]),
        smt([[{episodes: 3, totalMs: 900}]]), context);
    assert.match(verdict.detail, /1 of 1 cores throttling/);
});

test('the longest episode wins when several ended at once', () => {
    const verdict = assessCpu(
        smt([[{episodes: 1, totalMs: 500}], [{episodes: 1, totalMs: 9000}]]),
        smt([[{episodes: 1, totalMs: 0}], [{episodes: 1, totalMs: 0}]]), context);
    assert.equal(verdict.detail, '9.0 s throttled since the last poll — thermal (TCC)');
});

test('throttled time reads in units a person would use', () => {
    const ended = ms => assessCpu(
        smt([[{episodes: 1, totalMs: ms}]]),
        smt([[{episodes: 1, totalMs: 0}]]), context).detail;
    assert.match(ended(1), /^1 ms throttled since the last poll/);
    assert.match(ended(999), /^999 ms throttled since the last poll/);
    assert.match(ended(1000), /^1\.0 s throttled since the last poll/);
    assert.match(ended(9949), /^9\.9 s throttled since the last poll/);
    assert.match(ended(12_400), /^12 s throttled since the last poll/);
});

// The wording is load-bearing, not decoration. total_time_ms is an accumulator
// the kernel advances at each de-assert, so a poll spanning a TCC that toggled
// fifty times reports the sum of fifty short episodes. "Throttled for 6 s" —
// which this line used to say — asserts a single six-second episode that never
// happened, and on a laptop under sustained load that is the normal case.
test('the duration is the interval\'s total, not one episode\'s length', () => {
    const verdict = assessCpu(
        smt([[{episodes: 1, totalMs: 6000}]]),
        smt([[{episodes: 1, totalMs: 0}]]), context);
    assert.equal(verdict.detail, '6.0 s throttled since the last poll — thermal (TCC)');
    assert.doesNotMatch(verdict.detail, /Throttled for/);
});

test('an unreadable episode count falls back to the accumulator', () => {
    const verdict = assessCpu(
        smt([[{episodes: null, totalMs: 2000}]]),
        smt([[{episodes: null, totalMs: 500}]]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /^1\.5 s throttled since the last poll/);
});

// ── The package counter ────────────────────────────────────────────────────
//
// `package_throttle_count` is fed from MSR_IA32_PACKAGE_THERM_STATUS — the
// package's own TCC activation — and is the same grade of evidence as the core
// counter. Every CPU holds a copy of the one event, and with directed package
// interrupts only one copy is updated, so the question is "did any advance".

/** A reading with per-CPU copies of the package counter. */
const withPackage = (packageEpisodes, cores = [[0]]) =>
    ({...smt(cores), packageEpisodes});

test('an advancing package counter is CONFIRMED even with no core event', () => {
    const verdict = assessCpu(
        withPackage([4, 4, 4, 4]), withPackage([3, 3, 3, 3]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.equal(verdict.detail, 'CPU package throttling — thermal (TCC)');
    assert.equal(verdict.throttlingCount, undefined,
        'one package event is not a number of cores');
});

test('one CPU advancing is enough — the interrupt can be directed at any of them', () => {
    // X86_FEATURE_DPTI sends the package interrupt to a single unpredictable
    // CPU per package, so only that CPU's copy moves.
    const verdict = assessCpu(
        withPackage([1, 1, 9, 1]), withPackage([1, 1, 8, 1]), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
});

test('each package copy is compared with its own history', () => {
    // The copies hold different absolute values — a CPU that came online later
    // starts from a different point, and with a directed interrupt only one of
    // them has been advancing at all. Comparing them all against CPU 0's value
    // invents an event out of that spread: here nothing moved, but every entry
    // is above previous[0].
    const verdict = assessCpu(
        withPackage([1, 6]), withPackage([5, 6]), context);
    assert.equal(verdict.level, Confidence.LOW,
        'a static spread between copies is not a throttle');
});

test('package copies are never summed', () => {
    // Counting them would report a number of cores that does not exist. The
    // detail line must carry no count at all.
    const verdict = assessCpu(
        withPackage([2, 2, 2, 2]), withPackage([1, 1, 1, 1]), context);
    assert.doesNotMatch(verdict.detail, /\d/, 'no number in a package verdict');
});

test('a core count takes precedence over a package event', () => {
    const verdict = assessCpu(
        {...smt([[5], [5]]), packageEpisodes: [4]},
        {...smt([[4], [5]]), packageEpisodes: [3]}, context);
    assert.match(verdict.detail, /1 of 2 cores throttling/,
        'the specific answer beats the general one');
    assert.equal(verdict.throttlingCount, 1);
});

test('a package counter going backwards is a reset, not an event', () => {
    const verdict = assessCpu(withPackage([1]), withPackage([9]), context);
    assert.equal(verdict.level, Confidence.LOW);
});

test('a package counter list that changed length is not compared', () => {
    // The CPU set is fixed at discovery, so this cannot happen — but if it did,
    // index i would no longer be the same CPU, and every entry could read as a
    // jump. A false CONFIRMED is the one mistake this rule must not make.
    const verdict = assessCpu(withPackage([1, 2, 3]), withPackage([0, 0]), context);
    assert.equal(verdict.level, Confidence.LOW);
});

test('a reading with no package counters at all is not a throttle', () => {
    // AMD publishes none, and a pre-PTS Intel part publishes none either.
    const still = {...smt([[7]]), packageEpisodes: []};
    assert.equal(assessCpu(still, still, context).level, Confidence.LOW);
    const absent = smt([[7]]);
    assert.equal(assessCpu(absent, absent, context).level, Confidence.LOW);
});

test('an unreadable package counter is not an event', () => {
    const verdict = assessCpu(withPackage([null, 5]), withPackage([null, 5]), context);
    assert.equal(verdict.level, Confidence.LOW);
});

// ── The temperature tier ───────────────────────────────────────────────────
//
// TjMax runs from 85 °C to 125 °C across the parts coretemp knows about, so an
// absolute temperature says nothing on its own: 88 °C is twelve degrees of
// headroom on one laptop and two degrees past the trip point on another. The
// hardware publishes where it throttles; the rule measures against that, and
// treats the two settings as the preference they are.

/** A reading at `tempC` with a known trip point and no counters moving. */
const thermal = (tempC, throttlePointC) =>
    ({cores: [], packageEpisodes: [], packageTempC: tempC, throttlePointC});

const at = (tempC, throttlePointC, thresholds = context.thresholds) =>
    assessCpu(thermal(tempC, throttlePointC), null, {packageTempC: tempC, thresholds});

/** The same, plus the per-core channels `coretemp` publishes beside the package. */
const withCores = (tempC, throttlePointC, coreTemps, thresholds = context.thresholds) =>
    assessCpu({...thermal(tempC, throttlePointC), coreTemps}, null,
        {packageTempC: tempC, thresholds});

const core = (label, tempC, throttlePointC = 100, targetC = null) =>
    ({label, tempC, throttlePointC, targetC});

test('the headroom below the trip point is reported at every level', () => {
    // Thresholds out of the way, so this is the hardware's statement alone.
    const quiet = new Thresholds(120, 125);
    assert.equal(at(70, 100, quiet).detail, '30°C below the throttle point (100°C)');
    assert.equal(at(94, 100, quiet).detail, '6°C below the throttle point (100°C)');
    assert.equal(at(100, 100, quiet).detail, 'At the throttle point (100°C)');
    assert.equal(at(104, 100, quiet).detail, 'At the throttle point (100°C)',
        'past it reads the same: there is no negative headroom to report');
});

test('reaching the trip point is HIGH, whatever the user typed', () => {
    // A part with TjMax 90 throttles at 90. The default critical of 94 is not
    // reachable on it, so before the hardware was consulted this machine could
    // never report anything but "elevated" — right up to the throttle.
    const lenient = new Thresholds(120, 125);
    for (const thresholds of [context.thresholds, lenient]) {
        assert.equal(at(90, 90, thresholds).level, Confidence.HIGH);
        assert.equal(at(93, 90, thresholds).level, Confidence.HIGH, 'and beyond it');
    }
});

test('the kernel\'s own ten-degree band is what "approaching" means', () => {
    // therm_throt.c dismisses an assert more than 10 °C below the trip point as
    // a spike: "the system is not close to PROCHOT". Same question, same number.
    const lenient = new Thresholds(120, 125);
    assert.equal(at(89, 100, lenient).level, Confidence.LOW, '11 degrees is not close');
    assert.equal(at(90, 100, lenient).level, Confidence.MEDIUM, 'ten degrees is');
    assert.equal(at(99, 100, lenient).level, Confidence.MEDIUM);
});

test('a threshold the hardware disagrees with is attributed to the user', () => {
    // TjMax 110: 95 °C is fifteen degrees of headroom, and the default critical
    // of 94 still fires because the user asked for it. What the rule must not
    // do is call that "throttle imminent" — it is nothing of the kind.
    const verdict = at(95, 110);
    assert.equal(verdict.level, Confidence.HIGH, 'the preference sets the level');
    assert.equal(verdict.detail,
        '15°C below the throttle point (110°C) — above your critical threshold');
    assert.doesNotMatch(verdict.detail, /imminent|approaching/,
        'the wording may not claim hardware knowledge the rule does not have');
});

test('a warning threshold is attributed the same way', () => {
    assert.equal(at(89, 110).detail,
        '21°C below the throttle point (110°C) — above your warning threshold');
});

test('a threshold the hardware already agrees with is not attributed', () => {
    // Saying "above your warning threshold" when the hardware independently
    // reached the same level would credit the preference for a fact. Here both
    // say MEDIUM: 92 °C is above the 88 °C warning and 8 degrees below TjMax.
    const verdict = at(92, 100);
    assert.equal(verdict.level, Confidence.MEDIUM);
    assert.equal(verdict.detail, '8°C below the throttle point (100°C)');
});

test('a threshold weaker than the hardware is not attributed either', () => {
    // TjMax 90: at 90 °C the hardware says HIGH, while the user's settings only
    // reach their warning band (88 warn, 94 critical). The preference did not
    // raise anything, so mentioning it would credit it for the hardware's call.
    const verdict = at(90, 90);
    assert.equal(verdict.level, Confidence.HIGH);
    assert.equal(verdict.detail, 'At the throttle point (90°C)');
    assert.doesNotMatch(verdict.detail, /your/);

    // And the same when the two agree outright.
    assert.equal(at(100, 100).detail, 'At the throttle point (100°C)');
});

test('the worse of the two judgements wins, in both directions', () => {
    const strict = new Thresholds(60, 65);
    assert.equal(at(70, 100, strict).level, Confidence.HIGH, 'the preference is worse');
    assert.equal(at(100, 100, new Thresholds(120, 125)).level, Confidence.HIGH,
        'the hardware is worse');
});

test('a threshold above the trip point switches the preference off', () => {
    // The documented way to opt out: a warning the hardware can never reach
    // never fires, leaving the throttle point as the only thing that speaks.
    const off = new Thresholds(125, 125);
    assert.equal(at(99, 100, off).detail, '1°C below the throttle point (100°C)');
    assert.equal(at(99, 100, off).level, Confidence.MEDIUM, 'the hardware still speaks');
    assert.equal(at(70, 100, off).level, Confidence.LOW);
});

test('an unknown trip point falls back to the thresholds alone', () => {
    // The thermal-zone path, and every AMD part since Zen. No headroom to
    // report, so the rule says only what the preference says.
    for (const throttlePointC of [null, undefined, 0, -1]) {
        const verdict = at(95, throttlePointC);
        assert.equal(verdict.level, Confidence.HIGH, `for ${String(throttlePointC)}`);
        assert.equal(verdict.detail, 'above your critical threshold');
        assert.doesNotMatch(verdict.detail, /throttle point/);
    }
});

test('a nominal reading with no trip point still says something', () => {
    assert.equal(at(60, null).detail, 'Nominal');
});

test('a moving counter outranks any temperature verdict', () => {
    // The tier exists only for when nothing was counted. Proof beats headroom.
    const hot = {...thermal(100, 100), cores: [[cpu(5)]]};
    const before = {...thermal(100, 100), cores: [[cpu(4)]]};
    const verdict = assessCpu(hot, before, context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /1 of 1 cores throttling/);
});

test('neither counter moving is not a throttle', () => {
    const still = smt([[{episodes: 7, totalMs: 4000}]]);
    assert.equal(assessCpu(still, still, context).level, Confidence.LOW);
});

test('an episode count that went backwards is a reset, not an event', () => {
    const verdict = assessCpu(
        smt([[{episodes: 1, totalMs: 0}]]),
        smt([[{episodes: 9, totalMs: 0}]]), context);
    assert.equal(verdict.level, Confidence.LOW);
});

// TCC activation is a per-core event, and `coretemp` gives every core its own
// `_input` and `_crit`. `coretemp.c` reads the package's own DTS rather than the
// maximum of the cores, so one core can sit well above the package sensor — and
// this tier exists precisely to speak before the counter moves.
test('a core closer to its trip point than the package is the one that answers', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withCores(80, 100, [core('Core 0', 80), core('Core 1', 94)], quiet);
    assert.equal(verdict.level, Confidence.MEDIUM, 'six degrees is inside the kernel\'s band');
    assert.equal(verdict.detail, 'Core 1 at 94°C, 6°C below its throttle point (100°C)');
    assert.equal(verdict.summary, '80°C', 'the panel still shows the package sensor');
});

test('a core at its trip point is HIGH and says so without repeating itself', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withCores(80, 100, [core('Core 3', 101)], quiet);
    assert.equal(verdict.level, Confidence.HIGH);
    assert.equal(verdict.detail, 'Core 3 at its throttle point (100°C)');
});

test('the package answers when it is the tightest, and is not named', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withCores(96, 100, [core('Core 0', 70), core('Core 1', 72)], quiet);
    assert.equal(verdict.detail, '4°C below the throttle point (100°C)');
});

// Each channel is measured against its own trip point. Taking the distance
// between one sensor's reading and another's TjMax would be a number about no
// hardware at all — and on a part where the kernel had to guess at TjMax, both
// numbers move together only within a single channel.
test('a core is measured against its own trip point, not the package one', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withCores(60, 100, [core('Core 0', 84, 90)], quiet);
    assert.equal(verdict.detail, 'Core 0 at 84°C, 6°C below its throttle point (90°C)');
});

test('a core with no readable sensor or no trip point is skipped, not guessed at', () => {
    const quiet = new Thresholds(120, 125);
    const blind = [core('Core 0', null), core('Core 1', 99, null), core('Core 2', 99, 0)];
    assert.equal(withCores(70, 100, blind, quiet).detail,
        '30°C below the throttle point (100°C)');
});

test('a machine publishing no core channels reads exactly as it did before', () => {
    const quiet = new Thresholds(120, 125);
    assert.equal(withCores(94, 100, [], quiet).detail, '6°C below the throttle point (100°C)');
});

// The preference is a statement about the number on the panel. Applying it to a
// sensor the user cannot see would turn the indicator amber with no visible
// cause — 80°C on screen, and a warning threshold of 88 that nothing reached.
test('the user thresholds are compared against the package, not the hottest core', () => {
    const verdict = withCores(80, 130, [core('Core 1', 94, 130)], new Thresholds(88, 94));
    assert.equal(verdict.level, Confidence.LOW, 'no threshold and no band reached');
    assert.equal(verdict.detail, 'Core 1 at 94°C, 36°C below its throttle point (130°C)');
});

// `create_core_attrs()` builds the package channel and the core channels
// together, so a machine with one and not the other is a transient read failure
// rather than a shape of hardware. The cores are still evidence: reporting
// UNKNOWN beside a core at its trip point would be the one direction this rule
// must never fail in.
test('cores still answer when the package sensor is the thing that failed', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withCores(null, 100, [core('Core 1', 99)], quiet);
    assert.equal(verdict.level, Confidence.MEDIUM);
    assert.equal(verdict.summary, '?°C');
    assert.equal(verdict.detail, 'Core 1 at 99°C, 1°C below its throttle point (100°C)');
});

test('nothing readable anywhere is still UNKNOWN', () => {
    const verdict = withCores(null, 100, [core('Core 1', null)]);
    assert.equal(verdict.level, Confidence.UNKNOWN);
    assert.equal(verdict.detail, 'Temperature unreadable');
});

// The hottest sensor and the one closest to tripping are not the same question.
// `coretemp.c` calls `get_tjmax()` per core, so channels of one device can carry
// different trip points — an offset the platform applied to some cores and not
// others is enough. Ranking by temperature would then answer with a channel that
// has more headroom than one it outranked.
test('the tightest sensor answers, which is not always the hottest', () => {
    const quiet = new Thresholds(120, 125);
    // The package is the hottest reading; Core 0 is the closer to its own trip.
    const verdict = withCores(84, 100, [core('Core 0', 82, 90)], quiet);
    assert.equal(verdict.level, Confidence.MEDIUM);
    assert.equal(verdict.detail, 'Core 0 at 82°C, 8°C below its throttle point (90°C)');
});

// ── The lifetime worst episode ─────────────────────────────────────────────
//
// `therm_throt.c` keeps `max_time_ms` beside `total_time_ms` and writes both in
// the same de-assert branch: the longest single high-to-low episode since boot.
// It answers a different question from the two counters — not "is it throttling"
// but "how bad has it ever got" — and it is a lifetime figure, which is the
// whole of the wording problem.

const withMax = (counterValues, maxMs) =>
    ({cores: counterValues.map(v => [{...cpu(v), maxMs}]), packageTempC: 60});

test('a confirmed throttle carries the worst episode on record', () => {
    const verdict = assessCpu(withMax([11], 4200), withMax([10], 4200), context);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.equal(verdict.detail,
        '1 of 1 cores throttling — thermal (TCC); longest episode since boot 4.2 s');
});

// The reason it appears only beside a throttle: on screen while nothing is
// happening it would read as current state, and a machine that throttled badly
// three suspends ago would look like a machine throttling now.
test('a machine that is not throttling is told nothing about its history', () => {
    const quiet = new Thresholds(120, 125);
    const idle = {...withMax([10], 9000), throttlePointC: 100};
    const verdict = assessCpu(idle, withMax([10], 9000), {packageTempC: 60, thresholds: quiet});
    assert.equal(verdict.level, Confidence.LOW);
    assert.doesNotMatch(verdict.detail, /since boot/);
});

test('a machine with nothing on record says nothing rather than "0 ms"', () => {
    for (const maxMs of [0, null, undefined]) {
        const verdict = assessCpu(withMax([11], maxMs), withMax([10], maxMs), context);
        assert.equal(verdict.detail, '1 of 1 cores throttling — thermal (TCC)', String(maxMs));
    }
});

test('the worst of every core is what is reported, not the first', () => {
    const now = {cores: [[{...cpu(11), maxMs: 300}], [{...cpu(5), maxMs: 12_000}]],
        packageTempC: 60};
    const before = {cores: [[{...cpu(10), maxMs: 300}], [{...cpu(5), maxMs: 12_000}]],
        packageTempC: 60};
    assert.match(assessCpu(now, before, context).detail, /longest episode since boot 12 s/);
});

// Core and package are two levels of one event, and the question is neither
// which nor how many but how long the worst lasted.
test('the package figure counts too, and the larger of the two wins', () => {
    const reading = over => ({cores: [[{...cpu(11), maxMs: 800}]], packageTempC: 60, ...over});
    const before = {cores: [[{...cpu(10), maxMs: 800}]], packageTempC: 60};

    assert.match(assessCpu(reading({packageMaxMs: [5000, 5000]}), before, context).detail,
        /longest episode since boot 5.0 s/);
    assert.match(assessCpu(reading({packageMaxMs: [200, 200]}), before, context).detail,
        /longest episode since boot 800 ms/);
});

// An offline CPU's thermal_throttle attributes emit an empty string, which the
// port's strict parser reports as null. A parked CPU must not drag the maximum
// down to nothing.
test('an unreadable figure is skipped, not treated as zero', () => {
    const now = {cores: [[{...cpu(11), maxMs: null}, {...cpu(11), maxMs: 6000}]],
        packageTempC: 60};
    const before = {cores: [[{...cpu(10), maxMs: null}, {...cpu(10), maxMs: 6000}]],
        packageTempC: 60};
    assert.match(assessCpu(now, before, context).detail, /longest episode since boot 6.0 s/);
});

test('the package-only and lingering-episode verdicts carry it as well', () => {
    const shape = over => ({cores: [[cpu(10)]], packageTempC: 60, ...over});

    const packageTripped = assessCpu(
        shape({packageEpisodes: [4], packageMaxMs: [7500]}),
        shape({packageEpisodes: [3], packageMaxMs: [7500]}), context);
    assert.equal(packageTripped.detail,
        'CPU package throttling — thermal (TCC); longest episode since boot 7.5 s');

    const justEnded = assessCpu(
        {cores: [[{episodes: 10, totalMs: 900, maxMs: 900}]], packageTempC: 60},
        {cores: [[{episodes: 10, totalMs: 0, maxMs: 900}]], packageTempC: 60}, context);
    assert.equal(justEnded.detail,
        '900 ms throttled since the last poll — thermal (TCC); '
        + 'longest episode since boot 900 ms');
});

// ── The thermal target ─────────────────────────────────────────────────────
//
// `coretemp` fills `tempN_max` with ttarget: TjMax minus the offset in bits
// 8:15 of MSR_IA32_TEMPERATURE_TARGET, the temperature the platform actively
// tries to hold below. Sustained operation above it but below TjMax is a
// machine whose cooling is losing — a different fact from "about to throttle",
// and worded so it cannot be read as a second trip point.

const withTarget = (tempC, throttlePointC, targetC, thresholds = context.thresholds) =>
    assessCpu({...thermal(tempC, throttlePointC), targetC}, null,
        {packageTempC: tempC, thresholds});

test('past the target, the line says so without calling it a trip point', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withTarget(96, 100, 94, quiet);
    assert.equal(verdict.detail,
        '4°C below the throttle point (100°C) and past the 94°C it aims to hold');
});

test('below the target, nothing is added', () => {
    const quiet = new Thresholds(120, 125);
    assert.equal(withTarget(80, 100, 94, quiet).detail,
        '20°C below the throttle point (100°C)');
});

// The offset is zero on some parts, and coretemp then publishes a tempN_max
// equal to tempN_crit — a target the hardware only meets by throttling.
test('a target equal to the trip point is not a target', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = withTarget(99, 100, 100, quiet);
    assert.equal(verdict.detail, '1°C below the throttle point (100°C)');
    assert.equal(verdict.level, Confidence.MEDIUM, 'the kernel band still applies');
});

test('a part publishing no target reads exactly as it did before', () => {
    const quiet = new Thresholds(120, 125);
    for (const targetC of [null, undefined, 0])
        assert.equal(withTarget(96, 100, targetC, quiet).detail,
            '4°C below the throttle point (100°C)', String(targetC));
});

// The whole point of taking the worse of the two: ttarget's offset is small on
// some parts, so using it *instead* of the kernel's ten-degree band would give
// less warning rather than more.
test('the target adds a warning and never removes one', () => {
    const quiet = new Thresholds(120, 125);

    // 30°C of headroom, but past a low target: MEDIUM, which the band alone
    // would not have given.
    assert.equal(withTarget(70, 100, 65, quiet).level, Confidence.MEDIUM,
        'the hardware says it is hotter than intended');

    // Inside the band but below a high target: still MEDIUM, from the band.
    assert.equal(withTarget(93, 100, 97, quiet).level, Confidence.MEDIUM,
        'a generous target cannot cancel the kernel band');

    // Neither: LOW.
    assert.equal(withTarget(70, 100, 97, quiet).level, Confidence.LOW);
});

test('the target travels with the sensor that answered, not the package', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = assessCpu({
        ...thermal(70, 100),
        targetC: 65,
        coreTemps: [core('Core 3', 92, 100), {label: 'Core 4', tempC: 60,
            throttlePointC: 100, targetC: 55}],
    }, null, {packageTempC: 70, thresholds: quiet});

    // Core 3 has the least headroom and publishes no target of its own, so no
    // clause is added — the package's 65°C belongs to the package.
    assert.equal(verdict.detail,
        'Core 3 at 92°C, 8°C below its throttle point (100°C)');
});

test('a core past its own target says so, naming both of its numbers', () => {
    const quiet = new Thresholds(120, 125);
    const verdict = assessCpu({
        ...thermal(60, 100),
        coreTemps: [{label: 'Core 1', tempC: 96, throttlePointC: 100, targetC: 94}],
    }, null, {packageTempC: 60, thresholds: quiet});

    assert.equal(verdict.detail,
        'Core 1 at 96°C, 4°C below its throttle point (100°C) '
        + 'and past the 94°C it aims to hold');
});
