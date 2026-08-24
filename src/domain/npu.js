// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel NPU rules.
//
// The NPU exposes no throttle counter and no reason register — only a current
// frequency, a maximum, and a busy-time accumulator.  Running below maximum is
// therefore *never* evidence of throttling: it is equally consistent with a
// light workload.  Every active verdict is deliberately pinned to LOW, and the
// detail line carries whatever nuance the counters do support.
//
// The one thing outside the NPU it will mention is the CPU package being close
// to its own trip point, because on these parts they share a die and that is
// the likeliest reason an NPU is running slowly.  It is worded as an
// observation about the CPU, and it is only made when the CPU publishes a trip
// point to measure against.
//
// Raising this cap would require a signal the hardware does not currently
// publish; see BACKLOG.md.

import {Confidence} from './confidence.js';
// The same band every thermal judgement here uses, and for the same reason:
// it is the kernel's own definition of close to a trip point.
import {NEAR_THROTTLE_C} from './temperature.js';

/**
 * @typedef {object} NpuReading
 * @property {number|null} currentMhz
 * @property {number|null} maxMhz
 *   The ceiling in force — the configured one where the part publishes it, the
 *   hardware one otherwise. Every ratio here measures against this.
 * @property {number|null} hardwareMaxMhz
 *   The PLL's own ceiling. Equal to `maxMhz` unless software lowered it.
 * @property {number|null} busyUs  Monotonic busy-time accumulator.
 */

/**
 * At or above this share of the ceiling, the NPU is effectively at full tilt.
 *
 * The ceiling is the one in force, which is the whole point of the adapter
 * reading `freq/set_max_freq`: measured against `hw_max_freq` instead, a machine
 * whose firmware had lowered the ceiling would sit below this ratio for ever and
 * never be called nominal, however hard it was working.
 */
const NOMINAL_RATIO = 0.85;

/**
 * The frequency pair, and — only where it differs — the hardware ceiling the
 * configured one was lowered from. Saying so is the difference between "this
 * NPU is running at its limit" and "this NPU is running at the limit somebody
 * set", which are not the same statement about a machine.
 *
 * @param {NpuReading} reading
 * @returns {string}
 */
function frequencyText({currentMhz, maxMhz, hardwareMaxMhz}) {
    const text = `${currentMhz} / ${maxMhz} MHz`;
    return hardwareMaxMhz > maxMhz ? `${text} of ${hardwareMaxMhz} available` : text;
}

const unknown = () => ({level: Confidence.UNKNOWN, summary: 'No data', detail: ''});

/**
 * @param {NpuReading} reading
 * @param {NpuReading|null|undefined} previous
 * @param {import('./monitor.js').Context} context
 * @returns {string}
 */
function describeActivity(reading, previous, {packageTempC, packageThrottlePointC}) {
    const {currentMhz, maxMhz, busyUs} = reading;
    const frequency = frequencyText(reading);
    const previousBusyUs = previous?.busyUs ?? null;

    // With nothing to compare against — the first poll, or a previous poll whose
    // busy counter was unreadable — there is no interval to describe.  Say the
    // frequency and stop, rather than reporting idleness we have not observed.
    if (previousBusyUs === null)
        return frequency;

    // A negative delta means the accumulator reset (suspend/resume): not new work.
    if (Math.max(0, busyUs - previousBusyUs) === 0)
        return `${frequency} — no new work this interval`;

    const share = currentMhz / maxMhz;
    if (share >= NOMINAL_RATIO)
        return `${frequency} — nominal`;

    const percent = Math.round(share * 100);
    return `${frequency} (${percent}%)${thermalContext(packageTempC, packageThrottlePointC)}`;
}

/**
 * Whether the machine being hot is worth mentioning beside a slow NPU.
 *
 * The NPU publishes no throttle signal of its own, so this is the nearest thing
 * to a reason the rule can offer — and it is offered as an observation about the
 * CPU, not as a claim about the NPU. It is stated only when it can be grounded:
 * "the package is near its trip point" is a measurement, whereas "the package is
 * above a number the user typed" is not a fact about heat at all. Where the CPU
 * publishes no trip point, this says nothing rather than guessing.
 *
 * @param {number|null} packageTempC
 * @param {number|null} packageThrottlePointC
 * @returns {string}
 */
function thermalContext(packageTempC, packageThrottlePointC) {
    if (packageTempC === null || !(packageThrottlePointC > 0)) return '';
    const headroom = packageThrottlePointC - packageTempC;
    if (headroom > NEAR_THROTTLE_C) return '';
    return headroom <= 0
        ? ' — CPU at its throttle point'
        : ` — CPU ${headroom}°C from its throttle point`;
}

/**
 * @param {NpuReading|null} reading
 * @param {NpuReading|null|undefined} previous
 * @param {import('./monitor.js').Context} context
 * @returns {import('./monitor.js').Verdict}
 */
export function assessNpu(reading, previous, context) {
    if (!reading || reading.currentMhz === null || !(reading.maxMhz > 0))
        return unknown();

    if (reading.currentMhz === 0)
        return {
            level: Confidence.IDLE,
            summary: 'Idle',
            detail: frequencyText(reading),
        };

    // Running, but we cannot tell whether it is doing anything.
    if (reading.busyUs === null)
        return unknown();

    return {
        level: Confidence.LOW,
        summary: 'Active',
        detail: describeActivity(reading, previous, context),
    };
}
