// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The rule for a GPU that publishes temperatures and trip points but no reason
// registers — today, `amdgpu`.
//
// `src/domain/gpu.js` is the rule for a GPU that can say *why* it is throttling.
// This one is for hardware that cannot, and the difference is not a detail: an
// Intel GT reaches CONFIRMED because a driver register asserts PROCHOT, and
// nothing amdgpu publishes as plain text is that.
//
// `amdgpu_pm.c` documents `temp[1-3]_input` as the on-die temperature and
// `temp[1-3]_crit` as its "temperature critical max value" — the analogue of
// TjMax, and a genuine hardware trip point rather than a threshold somebody
// programmed. (`temp[1-3]_emergency` is a further point at which the ASIC shuts
// down, which is not a throttle and is not read.) That makes this the same
// judgement `src/domain/temperature.js` already makes for a CPU: headroom below
// a trip point, per channel, each against its own.
//
// The throttle status amdgpu does have lives in `gpu_metrics`, a versioned
// binary struct rather than a text attribute. Parsing a kernel ABI whose layout
// changes with the firmware, in order to raise a verdict to CONFIRMED, is
// exactly the kind of claim this project refuses to make cheaply — see
// BACKLOG.md.

import {Confidence} from './confidence.js';
import {describeHeadroom, temperatureLevel, tightestSensor} from './temperature.js';

/**
 * @typedef {object} GpuTemperatureReading
 * @property {import('./temperature.js').Sensor[]} sensors
 *   One per labelled hwmon channel — "edge", "junction", "mem".
 * @property {number|null} currentMhz  The gfx clock, where the driver says.
 */

/**
 * Assess a GPU from its temperatures alone.
 *
 * Capped at HIGH by construction, and that ceiling is the honest one: reaching
 * a trip point is the hardware saying it is at the temperature it throttles at,
 * which is strong evidence and still not a counter of events that happened.
 *
 * The clock is reported and never judged. amdgpu publishes `freq1_input` but no
 * maximum beside it, so there is no ceiling to measure against — and this
 * project has already once painted a frequency it could not explain as heat.
 *
 * @param {GpuTemperatureReading|null} reading
 * @param {GpuTemperatureReading|null|undefined} _previous  Unused: every signal is instantaneous.
 * @param {import('./monitor.js').Context} context
 * @returns {import('./monitor.js').Verdict}
 */
export function assessGpuTemperature(reading, _previous, {thresholds}) {
    if (!reading)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: ''};

    const tightest = tightestSensor(reading.sensors);
    const clock = reading.currentMhz !== null ? `${reading.currentMhz} MHz` : null;

    if (tightest === null)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: clock ?? ''};

    // The panel's temperature is the CPU's, so a GPU channel is a sensor the
    // user cannot see and its summary carries its own reading — the same reason
    // a named core's line does in the CPU rule.
    const summary = `${tightest.tempC}°C`;

    // The user's thresholds are compared against this GPU's own hottest usable
    // channel rather than against the panel number, because unlike the CPU
    // there is no panel number for it. "Tell me at 88°C" is then a statement
    // about a temperature this section is already showing.
    const user = thresholds.isCritical(tightest.tempC) ? Confidence.HIGH
        : thresholds.isWarm(tightest.tempC) ? Confidence.MEDIUM
            : Confidence.LOW;

    const hardware = temperatureLevel(tightest);
    const level = hardware === Confidence.HIGH || user === Confidence.HIGH ? Confidence.HIGH
        : hardware === Confidence.MEDIUM || user === Confidence.MEDIUM ? Confidence.MEDIUM
            : Confidence.LOW;

    const detail = [describeHeadroom(tightest), clock].filter(Boolean).join(' — ');
    return {level, summary, detail};
}
