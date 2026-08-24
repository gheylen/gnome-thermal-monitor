// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {assessNpu} from '../../src/domain/npu.js';
import {Thresholds} from '../../src/domain/thresholds.js';

const context = (packageTempC, packageThrottlePointC = 100) =>
    ({packageTempC, packageThrottlePointC, thresholds: new Thresholds(85, 95)});

const cool = context(50);
const hot = context(94);          // six degrees below a 100 °C trip point
const npu = (over = {}) => {
    const reading = {currentMhz: 1000, maxMhz: 2000, busyUs: 5000, ...over};
    // A part that publishes no configured ceiling reports the hardware one as
    // its ceiling, so the two are equal unless a test says otherwise.
    return {hardwareMaxMhz: reading.maxMhz, ...reading};
};

test('missing or nonsensical readings → UNKNOWN', () => {
    for (const reading of [null, npu({currentMhz: null}), npu({maxMhz: null}), npu({maxMhz: 0})])
        assert.equal(assessNpu(reading, null, cool).level, Confidence.UNKNOWN);
});

test('a stopped clock means IDLE', () => {
    const verdict = assessNpu(npu({currentMhz: 0}), null, cool);
    assert.equal(verdict.level, Confidence.IDLE);
    assert.equal(verdict.detail, '0 / 2000 MHz');
});

test('running but with an unreadable busy counter → UNKNOWN, not a guess', () => {
    assert.equal(assessNpu(npu({busyUs: null}), npu(), cool).level, Confidence.UNKNOWN);
});

test('no new busy time this interval is reported as such', () => {
    const verdict = assessNpu(npu({busyUs: 5000}), npu({busyUs: 5000}), cool);
    assert.match(verdict.detail, /no new work this interval/);
});

test('a busy counter that went backwards is a reset, not new work', () => {
    const verdict = assessNpu(npu({busyUs: 10}), npu({busyUs: 9000}), cool);
    assert.match(verdict.detail, /no new work this interval/);
});

test('working at or above 85% of maximum is nominal', () => {
    const previous = npu({busyUs: 1000});
    assert.match(assessNpu(npu({currentMhz: 1900, busyUs: 5000}), previous, cool).detail,
        /1900 \/ 2000 MHz — nominal/);
    assert.match(assessNpu(npu({currentMhz: 1700, busyUs: 5000}), previous, cool).detail,
        /— nominal/, 'exactly 85%');
});

test('working below 85% shows the shortfall as a percentage', () => {
    const verdict = assessNpu(npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}), cool);
    assert.match(verdict.detail, /1000 \/ 2000 MHz \(50%\)$/);
});

// The NPU has no throttle signal of its own, so the nearest thing to a reason it
// can offer is that the CPU it shares a die with is close to its trip point.
// That is stated as an observation about the CPU, and only where there is a trip
// point to measure against — "hotter than a number the user typed" is not a fact
// about heat, and it was what this line used to be built on.
test('a CPU near its trip point is mentioned, and never raises the level', () => {
    const busy = () => assessNpu(npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}), hot);
    assert.equal(busy().level, Confidence.LOW);
    assert.equal(busy().detail, '1000 / 2000 MHz (50%) — CPU 6°C from its throttle point');
});

test('a CPU at its trip point is worded without a number', () => {
    const verdict = assessNpu(
        npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}), context(101));
    assert.match(verdict.detail, / — CPU at its throttle point$/);
    assert.equal(verdict.level, Confidence.LOW);
});

test('a CPU with headroom to spare is not mentioned at all', () => {
    const verdict = assessNpu(
        npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}), context(89));
    assert.equal(verdict.detail, '1000 / 2000 MHz (50%)', 'eleven degrees is not close');
});

test('without a CPU trip point the caveat is not guessed at', () => {
    // The thermal-zone path and every AMD part since Zen. The user's thresholds
    // are a preference, not a measurement, so they cannot stand in for one.
    for (const packageThrottlePointC of [null, 0, -1, undefined]) {
        // Built inline: a default parameter would swallow the undefined case,
        // which is the one a component with no projection at all produces.
        const bare = {packageTempC: 99, thresholds: new Thresholds(85, 95)};
        const verdict = assessNpu(npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}),
            {...bare, ...(packageThrottlePointC === undefined ? {} : {packageThrottlePointC})});
        assert.equal(verdict.detail, '1000 / 2000 MHz (50%)',
            `for ${String(packageThrottlePointC)}`);
    }
});

test('an unreadable package temperature is not treated as cool', () => {
    const verdict = assessNpu(
        npu({currentMhz: 1000, busyUs: 5000}), npu({busyUs: 1000}), context(null));
    assert.equal(verdict.detail, '1000 / 2000 MHz (50%)');
});

test('the first poll has nothing to compare against and says nothing about work', () => {
    // Reporting "no new work this interval" here would be an observation the
    // extension has not made: a saturated NPU looks identical on its first poll.
    const verdict = assessNpu(npu(), undefined, cool);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.detail, '1000 / 2000 MHz');
});

test('an unreadable previous busy counter is treated the same as no previous poll', () => {
    const verdict = assessNpu(npu(), npu({busyUs: null}), cool);
    assert.equal(verdict.detail, '1000 / 2000 MHz');
});

test('once there is an interval to compare, idleness is reported', () => {
    assert.match(assessNpu(npu({busyUs: 5000}), npu({busyUs: 5000}), cool).detail,
        /no new work this interval/);
});

// The NPU publishes no throttle signal at all, so claiming more than LOW while
// it is running would be an invention.  This is the guard on that promise.
test('no active reading can ever exceed LOW', () => {
    const inputs = [
        [npu({currentMhz: 1, busyUs: 9_000_000}), npu({busyUs: 0}), hot],
        [npu({currentMhz: 2000, busyUs: 9_000_000}), npu({busyUs: 0}), hot],
        [npu({currentMhz: 1000, busyUs: 1}), npu({busyUs: 0}), hot],
    ];
    for (const [reading, previous, context] of inputs)
        assert.equal(assessNpu(reading, previous, context).level, Confidence.LOW);
});

// The bug this closes: measured against the *hardware* ceiling, an NPU whose
// firmware had lowered its own would sit below NOMINAL_RATIO for ever and never
// be called nominal, however hard it was working. `ivpu_sysfs.c` publishes the
// configured ceiling as `freq/set_max_freq` on 50XX-generation parts and newer.
test('an NPU at its configured ceiling is nominal, and says what it was lowered from', () => {
    const capped = npu({currentMhz: 1000, maxMhz: 1000, hardwareMaxMhz: 2000});
    const verdict = assessNpu(capped, npu({busyUs: 1000}), cool);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.detail, '1000 / 1000 MHz of 2000 available — nominal');
});

test('an uncapped NPU does not mention a second ceiling', () => {
    const verdict = assessNpu(npu({currentMhz: 1900}), npu({busyUs: 1000}), cool);
    assert.equal(verdict.detail, '1900 / 2000 MHz — nominal');
});

test('the idle line names the ceiling in force too', () => {
    const capped = npu({currentMhz: 0, maxMhz: 1000, hardwareMaxMhz: 2000});
    assert.equal(assessNpu(capped, null, cool).detail, '0 / 1000 MHz of 2000 available');
});
