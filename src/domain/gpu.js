// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Integrated GPU rules, shared by the xe and i915 adapters.
//
// Two tiers of evidence:
//
//   1. Throttle reason flags.  Both drivers expose them per GT — xe under
//      `freq0/throttle/`, i915 as `throttle_reason_*` on the GT itself — so a
//      GPU can state *why* it is throttling.  PROCHOT is proof; a thermal flag
//      is strong.  Which flags are thermal, and what to call them, is hardware
//      knowledge: see `src/hardware/gpu-reasons.js`.  The i915 legacy sysfs
//      layout has none of these, and reads them as null.
//   2. Frequency shape.  Both drivers expose current / max / RP0 (hardware
//      boost ceiling).  This tier is weak on purpose: `max_freq` is a *request*
//      that software can lower — TLP, gamemode and `intel_gpu_frequency` all do
//      — so a max below RP0 says somebody asked for less, which is the opposite
//      of the hardware deciding to throttle.  It never exceeds LOW, which means
//      a GPU verdict is CONFIRMED, HIGH, IDLE, UNKNOWN or LOW and never MEDIUM:
//      unlike the CPU, a GPU publishes no distance-to-trip-point to be
//      "approaching" anything with.

import {Confidence} from './confidence.js';

/**
 * @typedef {object} GpuReading
 * @property {number|null} currentMhz  Requested frequency.
 * @property {number|null} maxMhz      Current ceiling (may be driver-capped).
 * @property {number|null} rp0Mhz      Hardware boost ceiling; the yardstick.
 * @property {boolean} idle            Render/media engines parked.
 *
 * @property {string|null} thermalReason
 *   The thermal limit this GT reports as asserted, already named by the
 *   adapter — "thermal", "SoC thermal", and so on — or null if none is, or if
 *   the platform publishes none to read. Which flags count as thermal is
 *   hardware knowledge and lives in `src/hardware/gpu-reasons.js`.
 * @property {number|null} prochot   PROCHOT reason flag, or null if unreadable.
 * @property {number|null} throttled Any limit is active — power included.
 */

/** Below this share of the boost ceiling the GPU is notably off its peak. */
const BELOW_MAX_RATIO = 0.75;

const frequencyText = ({currentMhz, rp0Mhz}) =>
    `${currentMhz ?? '?'} / ${rp0Mhz > 0 ? rp0Mhz : '?'} MHz`;

/** A usable boost ceiling: the yardstick every frequency ratio measures against. */
const hasCeiling = reading => reading.rp0Mhz > 0;

/**
 * Cases that must be answered before anything else: no reading at all, or an
 * idle engine, which cannot be throttling whatever else the registers say.
 *
 * Note this deliberately does *not* require a boost ceiling.  Only the
 * frequency-shape tier needs one; the xe throttle registers are direct
 * statements about the hardware, and refusing to report a confirmed PROCHOT
 * because `rp0_freq` was unreadable would throw away the best signal the
 * driver has.
 *
 * @param {GpuReading|null} reading
 * @returns {import('./monitor.js').Verdict|null}
 */
function guard(reading) {
    if (!reading)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: ''};
    if (reading.idle)
        return {level: Confidence.IDLE, summary: 'Idle', detail: frequencyText(reading)};
    return null;
}

/**
 * The frequency-shape tier, used by both drivers.
 *
 * Takes no context, and that is the point. It used to escalate on a warm CPU
 * package, which is how a software frequency cap came to be painted as heat —
 * the package temperature says nothing about why a GPU's ceiling was lowered.
 *
 * @param {GpuReading} reading
 * @returns {import('./monitor.js').Verdict}
 */
function assessFrequency(reading) {
    const {currentMhz, maxMhz, rp0Mhz} = reading;

    // Without a ceiling there is nothing to measure against, and every ratio
    // below would compare with zero and quietly report "nominal". Whatever
    // frequency did read is still worth showing.
    if (!hasCeiling(reading))
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: frequencyText(reading)};

    // A ceiling below RP0 means software asked for less — TLP on battery,
    // gamemode, `intel_gpu_frequency`, a one-line experiment.  The kernel
    // documents `max_freq` as a *request*, and PCODE decides the real clock.
    //
    // Compared exactly, and reported at LOW. Both used to be otherwise, and
    // both were wrong in the same direction:
    //
    //   The comparison carried a 5 % tolerance, which on a 2050 MHz ceiling is
    //   two 50 MHz steps — a real one-step cap was invisible. There is nothing
    //   for a tolerance to absorb: both numbers come from the same driver in
    //   the same units, and both drivers initialise `max_freq` to exactly
    //   `rp0`, so any inequality is somebody having asked for less.
    //
    //   The level was MEDIUM, which this project's vocabulary defines as a
    //   temperature approaching its threshold. A ceiling somebody set is not
    //   evidence of heat at all — it is the user's own power policy, reported
    //   back to them — and MEDIUM turns the panel amber and un-hides it under
    //   `hide-when-nominal`. LOW is what it is: running below maximum, with no
    //   thermal cause established.
    if (maxMhz !== null && maxMhz < rp0Mhz)
        return {
            level: Confidence.LOW,
            summary: 'Frequency limited',
            detail: `${maxMhz} / ${rp0Mhz} MHz ceiling — set by software, not the hardware`,
        };

    // A ceiling on its own says nothing about what the GPU is doing.  Calling
    // that "nominal" would be a claim made from no evidence — and the only
    // reading that says what the GPU is doing is the current frequency, so an
    // unreadable one lands here whether or not the ceiling read.
    //
    // The cap check above is deliberately allowed to fire first: it is a
    // statement about the ceiling, which it can make from the ceiling alone,
    // and it claims nothing about the GPU's activity.
    if (currentMhz === null)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: frequencyText(reading)};

    if (currentMhz !== null && currentMhz < rp0Mhz * BELOW_MAX_RATIO)
        return {
            level: Confidence.LOW,
            summary: 'Below maximum',
            detail: `${frequencyText(reading)} — P-state or power limit`,
        };

    return {level: Confidence.LOW, summary: 'Nominal', detail: frequencyText(reading)};
}

/**
 * Assess one GT.
 *
 * Every input is in the reading. The previous poll is unused because each
 * signal here is instantaneous rather than a counter, and the shared context is
 * unused because nothing outside this GT bears on whether it is throttling.
 *
 * @param {GpuReading|null} reading
 * @param {GpuReading|null|undefined} _previous  Unused: every signal is instantaneous.
 * @param {import('./monitor.js').Context} _context  Unused: see above.
 * @returns {import('./monitor.js').Verdict}
 */
export function assessGpu(reading, _previous, _context) {
    const guarded = guard(reading);
    if (guarded) return guarded;

    const frequency = frequencyText(reading);

    // `throttle_reason_status` (i915) and `throttle/status` (xe) are 1 whenever
    // *any* limit is asserted, and on a laptop GPU the sustained power limit
    // (PL1) is asserted under nearly every real workload.  So status alone is
    // not a finding; it only says the reason flags are worth believing.  A
    // driver that does not publish it reads null, which is not a denial.
    //
    // Status and the reason flags are separate register reads, so a throttle
    // beginning between them can show status 0 beside prochot 1.  Requiring
    // status keeps that poll quiet and lets the next one report it — the
    // conservative direction, and the only one available to a rule whose whole
    // claim is that it does not overstate what the hardware said.
    const limited = reading.throttled !== 0;

    if (limited && reading.prochot === 1)
        return {level: Confidence.CONFIRMED, summary: 'Throttled', detail: `${frequency} — PROCHOT`};

    if (limited && reading.thermalReason)
        return {
            level: Confidence.HIGH,
            summary: 'Throttled',
            detail: `${frequency} — ${reading.thermalReason}`,
        };

    return assessFrequency(reading);
}
