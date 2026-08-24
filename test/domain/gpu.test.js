// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The GPU rule, shared by both drivers.
//
// The evidence it weighs, and how much each is worth, comes from the kernel:
//
//   throttle_reason_prochot / reason_prochot   proof — CONFIRMED
//   throttle_reason_thermal / reason_thermal   strong — HIGH
//   throttle_reason_status  / status           1 whenever *any* limit is
//       asserted, power limits included. On a laptop GPU the sustained power
//       limit (PL1) is asserted under nearly every real workload, so this on
//       its own is not a finding — it only says the reason flags are live.
//   max_freq below RP0                         a software *request*, not a
//       hardware report. TLP, gamemode and intel_gpu_frequency all lower it.
//       Worth showing; never evidence of anything thermal.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {assessGpu} from '../../src/domain/gpu.js';
import {Thresholds} from '../../src/domain/thresholds.js';

const RP0 = 2000;
const cool = {packageTempC: 50, thresholds: new Thresholds(85, 95)};
const hot = {packageTempC: 90, thresholds: new Thresholds(85, 95)};

const gpu = (over = {}) => ({
    currentMhz: 1500, maxMhz: RP0, rp0Mhz: RP0, idle: false,
    throttled: 0, thermalReason: null, prochot: 0, ...over,
});

// ── Guards ────────────────────────────────────────────────────────────────

test('no reading → UNKNOWN', () => {
    assert.equal(assessGpu(null, null, cool).level, Confidence.UNKNOWN);
});

test('a parked engine is IDLE, not throttled', () => {
    const verdict = assessGpu(gpu({idle: true, currentMhz: 300}), null, cool);
    assert.equal(verdict.level, Confidence.IDLE);
    assert.equal(verdict.detail, `300 / ${RP0} MHz`);
});

test('a parked engine is IDLE even with a throttle flag still set', () => {
    assert.equal(assessGpu(gpu({idle: true, throttled: 1, prochot: 1}), null, cool).level,
        Confidence.IDLE);
});

// ── Reason flags ──────────────────────────────────────────────────────────

test('a PROCHOT flag while limited is proof → CONFIRMED', () => {
    const verdict = assessGpu(gpu({throttled: 1, prochot: 1}), null, cool);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /PROCHOT/);
});

test('a thermal flag while limited is strong but not proof → HIGH', () => {
    const verdict = assessGpu(gpu({throttled: 1, thermalReason: 'thermal'}), null, cool);
    assert.equal(verdict.level, Confidence.HIGH);
    assert.match(verdict.detail, /thermal/);
});

test('PROCHOT outranks thermal', () => {
    assert.equal(assessGpu(gpu({throttled: 1, prochot: 1, thermalReason: 'thermal'}), null, cool).level,
        Confidence.CONFIRMED);
});

test('a reason flag is ignored while the driver reports no limit at all', () => {
    assert.equal(assessGpu(gpu({throttled: 0, prochot: 1}), null, cool).summary, 'Nominal');
    assert.equal(assessGpu(gpu({throttled: 0, thermalReason: 'thermal'}), null, cool).summary, 'Nominal');
});

test('an unreadable status is not a denial, so the reasons still stand', () => {
    // A driver or layout that does not publish status reads null; refusing to
    // act on a reason there would lose real detection on i915's legacy layout.
    assert.equal(assessGpu(gpu({throttled: null, prochot: 1}), null, cool).level,
        Confidence.CONFIRMED);
    assert.equal(assessGpu(gpu({throttled: null, thermalReason: 'thermal'}), null, cool).level,
        Confidence.HIGH);
});

// This is the finding that a power limit must not masquerade as a thermal one.
test('a limit with no thermal reason is not a throttle finding', () => {
    // status=1 with no thermal or PROCHOT flag is, in practice, PL1 — the
    // sustained power limit, asserted whenever the GPU does real work. Calling
    // that MEDIUM turned the panel orange during ordinary video playback.
    const verdict = assessGpu(gpu({throttled: 1, currentMhz: 1800}), null, cool);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.summary, 'Nominal');
});

test('a confirmed throttle is reported even with no usable boost ceiling', () => {
    // Only the frequency comparison needs the ceiling; the reason flags are
    // direct statements about the hardware.
    for (const rp0Mhz of [null, 0]) {
        const verdict = assessGpu(gpu({rp0Mhz, throttled: 1, prochot: 1}), null, cool);
        assert.equal(verdict.level, Confidence.CONFIRMED, `for rp0 ${rp0Mhz}`);
        assert.match(verdict.detail, /\? MHz — PROCHOT/);
    }
});

// ── Frequency shape ───────────────────────────────────────────────────────

test('no usable RP0 means no yardstick → UNKNOWN', () => {
    for (const rp0Mhz of [null, 0, -1]) {
        const verdict = assessGpu(gpu({rp0Mhz, currentMhz: 1500, maxMhz: 0}), null, cool);
        assert.equal(verdict.level, Confidence.UNKNOWN, `for rp0 ${rp0Mhz}`);
    }
});

test('a ceiling below RP0 is reported as a software limit, not as heat', () => {
    const verdict = assessGpu(gpu({maxMhz: 1000}), null, cool);
    assert.equal(verdict.summary, 'Frequency limited');
    assert.match(verdict.detail, /1000 \/ 2000 MHz ceiling — set by software, not the hardware/);
    // LOW, not MEDIUM: this vocabulary defines MEDIUM as a temperature
    // approaching its threshold, and a ceiling somebody set is the user's own
    // power policy reported back to them. MEDIUM would turn the panel orange
    // and un-hide it under `hide-when-nominal` for TLP doing its job.
    assert.equal(verdict.level, Confidence.LOW);
});

test('a warm CPU does not turn a software ceiling into a thermal verdict', () => {
    // It used to escalate to HIGH, which is rendered identically to CONFIRMED —
    // so "somebody capped the GPU and the CPU is warm" painted the same panel
    // as a hardware PROCHOT.
    assert.equal(assessGpu(gpu({maxMhz: 1000}), null, hot).level, Confidence.LOW);
    assert.equal(assessGpu(gpu({maxMhz: 1000}), null, cool).level, Confidence.LOW);
});

test('whatever the adapter named the thermal limit is what the line says', () => {
    // The rule does not know which flags are thermal or what they are called —
    // that is hardware knowledge, and lives in src/hardware/gpu-reasons.js. Its
    // only job here is to believe the adapter and put the name on the line.
    for (const label of ['thermal', 'SoC thermal', 'voltage regulator thermal alert']) {
        const verdict = assessGpu(gpu({throttled: 1, thermalReason: label}), null, cool);
        assert.equal(verdict.level, Confidence.HIGH, label);
        assert.equal(verdict.detail, `1500 / 2000 MHz — ${label}`);
    }
});

test('a PROCHOT flag outranks any thermal limit beside it', () => {
    // One is proof and the other is strong evidence; reporting the weaker of
    // the two would be the only way this rule could understate itself.
    const verdict = assessGpu(
        gpu({throttled: 1, prochot: 1, thermalReason: 'SoC thermal'}), null, cool);
    assert.equal(verdict.level, Confidence.CONFIRMED);
    assert.match(verdict.detail, /— PROCHOT$/);
});

test('a GPU verdict is never MEDIUM', () => {
    // Unlike the CPU, a GPU publishes no distance to a trip point, so there is
    // nothing for it to be "approaching". Every shape this rule can produce
    // lands on CONFIRMED, HIGH, LOW, IDLE or UNKNOWN.
    const shapes = [
        {}, {maxMhz: 1}, {currentMhz: 1}, {maxMhz: null}, {currentMhz: null},
        {rp0Mhz: null}, {idle: true}, {throttled: 1, thermalReason: 'thermal'}, {throttled: 1, prochot: 1},
        {throttled: null, thermalReason: null, prochot: null},
    ];
    for (const shape of shapes)
        for (const context of [cool, hot])
            assert.notEqual(assessGpu(gpu(shape), null, context).level, Confidence.MEDIUM,
                JSON.stringify(shape));
});

test('a ceiling one step below RP0 is a limit', () => {
    // The comparison used to carry a 5 % tolerance, which on a 2050 MHz ceiling
    // is two 50 MHz steps: a real one-step cap was invisible. Both numbers come
    // from the same driver in the same units and both drivers initialise
    // max_freq to exactly rp0, so there is nothing for a tolerance to absorb.
    assert.equal(assessGpu(gpu({maxMhz: RP0 - 50, currentMhz: 1900}), null, cool).summary,
        'Frequency limited');
    assert.equal(assessGpu(gpu({maxMhz: RP0 - 1, currentMhz: 1900}), null, cool).summary,
        'Frequency limited');
});

test('a ceiling at RP0 is not a limit', () => {
    const verdict = assessGpu(gpu({maxMhz: RP0, currentMhz: 1900}), null, hot);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.summary, 'Nominal');
});

test('a ceiling above RP0 is not a limit either', () => {
    // Not a shape any driver produces, but the comparison should not invert.
    assert.equal(assessGpu(gpu({maxMhz: RP0 + 50, currentMhz: 1900}), null, cool).summary,
        'Nominal');
});

test('a ceiling outranks merely running below maximum', () => {
    assert.equal(assessGpu(gpu({maxMhz: 1000, currentMhz: 300}), null, cool).summary,
        'Frequency limited');
});

test('uncapped but well below RP0 → LOW, cause unclaimed', () => {
    const verdict = assessGpu(gpu({currentMhz: 1000}), null, cool);
    assert.equal(verdict.level, Confidence.LOW);
    assert.equal(verdict.summary, 'Below maximum');
    assert.match(verdict.detail, /P-state or power limit/);
});

test('exactly 75% of RP0 is not below maximum', () => {
    assert.equal(assessGpu(gpu({currentMhz: RP0 * 0.75}), null, cool).summary, 'Nominal');
});

test('uncapped and near RP0 → LOW nominal', () => {
    assert.equal(assessGpu(gpu({currentMhz: 1800}), null, cool).summary, 'Nominal');
});

test('an unreadable max is not a limit', () => {
    assert.equal(assessGpu(gpu({maxMhz: null, currentMhz: 1000}), null, cool).summary,
        'Below maximum');
});

// The current frequency is the only reading that says what the GPU is *doing*.
// Without it there is nothing to call nominal, however well the ceiling reads —
// a ceiling sitting at the hardware maximum is consistent with any clock at all.
test('an unreadable current frequency is not "nominal", whatever else read', () => {
    for (const shape of [{currentMhz: null}, {currentMhz: null, maxMhz: null}]) {
        const verdict = assessGpu(gpu(shape), null, cool);
        assert.equal(verdict.level, Confidence.UNKNOWN, JSON.stringify(shape));
        assert.equal(verdict.summary, 'No data');
    }
});

test('an unreadable frequency still renders whatever did read', () => {
    assert.match(assessGpu(gpu({currentMhz: null}), null, cool).detail, /\? \/ 2000 MHz/);
    assert.match(assessGpu(gpu({rp0Mhz: null}), null, cool).detail, /1500 \/ \? MHz/);
});

test('a lowered ceiling is reported even when the current clock is unreadable', () => {
    // This one claims nothing about what the GPU is doing: it is a statement
    // about the ceiling, made from the ceiling, so it may precede the guard
    // above.
    assert.equal(assessGpu(gpu({currentMhz: 1800, maxMhz: null}), null, cool).summary, 'Nominal');
    assert.equal(assessGpu(gpu({currentMhz: null, maxMhz: 1000}), null, cool).summary,
        'Frequency limited');
});

test('no verdict ever exceeds HIGH on frequency shape alone', () => {
    // CONFIRMED must come from a counter, never from a ratio.
    const shapes = [
        {maxMhz: 1}, {maxMhz: 1, currentMhz: 1}, {currentMhz: 1},
        {maxMhz: null}, {currentMhz: null},
    ];
    for (const shape of shapes) {
        const verdict = assessGpu(gpu({...shape, throttled: 0, thermalReason: null, prochot: 0}), null, hot);
        assert.notEqual(verdict.level, Confidence.CONFIRMED, JSON.stringify(shape));
    }
});
