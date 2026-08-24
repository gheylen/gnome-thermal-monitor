// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Headroom below a trip point — the one thermal judgement that is not about any
// particular kind of silicon.
//
// A sensor, the temperature it publishes, and the temperature its own hardware
// says it throttles at: that triple is the whole input, and the answer is how
// much room is left and how worried to be about it. `coretemp` supplies it per
// core and per package, `k10temp` supplies it once, and `amdgpu` supplies it per
// edge/junction/memory channel. None of that is knowledge this module needs.
//
// It lives here rather than in `src/domain/cpu.js` because the second driver to
// want it proved it was never a CPU rule. What stayed behind in cpu.js is the
// part that genuinely is one: the throttle counters, and what TCC activation
// means.

import {Confidence, isWorse, worstOf} from './confidence.js';

/**
 * @typedef {object} Sensor        One channel, and the two or three numbers it
 *                                 publishes about itself.
 * @property {string|null} label   What to call it, or null for the channel whose
 *   reading is already on the panel and so needs no attribution.
 * @property {number|null} tempC
 * @property {number|null} throttlePointC  Where this channel's hardware throttles.
 * @property {number|null} [targetC]
 *   The temperature the platform actively tries to hold below, where it says.
 */

/**
 * How close to a trip point counts as approaching it.
 *
 * Not a taste judgement: `therm_throt.c` uses the same number for the same
 * question.  On the assert interrupt it reads the digital readout and bails out
 * with `if (temp > 10) return;` — "Ignore short temperature spike as the system
 * is not close to PROCHOT. 10C offset is large enough to ignore."  Ten degrees
 * below the trip point is the kernel's own definition of close, so it is this
 * module's.
 */
export const NEAR_THROTTLE_C = 10;

/**
 * The sensor with the least headroom, out of every channel offered.
 *
 * A single hot channel is invisible to any other: `coretemp.c` reads the
 * package's own DTS rather than the maximum of the cores, and `amdgpu` reports
 * an edge temperature that a junction sensor can sit well above. Measuring one
 * channel would call such a machine nominal right up until it tripped, which is
 * the moment this tier exists to precede.
 *
 * Each channel is measured against *its own* trip point and never another's.
 * On `coretemp`, `_input` is computed as `tjmax - digital_readout` from the same
 * sensor, so the difference is that sensor's own count of degrees remaining; a
 * distance taken between two channels would be a number about no hardware at
 * all.
 *
 * @param {Sensor[]} sensors
 * @returns {{label: string|null, tempC: number, throttlePointC: number,
 *            targetC: number|null}|null}
 */
export function tightestSensor(sensors) {
    const candidates = sensors.filter(
        ({tempC, throttlePointC}) => tempC !== null && throttlePointC > 0);

    if (candidates.length === 0) return null;
    return candidates.reduce((tightest, sensor) =>
        sensor.throttlePointC - sensor.tempC < tightest.throttlePointC - tightest.tempC
            ? sensor
            : tightest);
}

/**
 * Whether this sensor is at or past the temperature its platform tries to hold.
 *
 * Only when the target is strictly below the trip point. The offset in bits
 * 8:15 of `MSR_IA32_TEMPERATURE_TARGET` is zero on some parts, and coretemp then
 * publishes a `tempN_max` equal to `tempN_crit` — a "target" the hardware only
 * meets by throttling, which says nothing the trip point does not.
 *
 * Not exported: the two callers below are the only questions worth asking of
 * it, and both live here.
 *
 * @param {{tempC: number, throttlePointC: number, targetC?: number|null}} sensor
 * @returns {boolean}
 */
function pastTarget({tempC, throttlePointC, targetC}) {
    return targetC !== null && targetC !== undefined && targetC > 0
        && targetC < throttlePointC && tempC >= targetC;
}

/**
 * What the hardware alone makes of this sensor.
 *
 * The target can add a warning and never remove one. `ttarget` is the trip point
 * minus an offset the part chooses, and that offset is small on some of them —
 * three degrees, where the kernel's own band is ten. Taking the worse of the two
 * is the rule the whole verdict is built on, and it means a hardware-published
 * threshold can only ever tell us more.
 *
 * @param {{tempC: number, throttlePointC: number, targetC?: number|null}|null} tightest
 * @returns {import('./confidence.js').Level}
 */
export function temperatureLevel(tightest) {
    if (tightest === null) return Confidence.LOW;
    const headroom = tightest.throttlePointC - tightest.tempC;

    if (headroom <= 0) return Confidence.HIGH;
    if (headroom <= NEAR_THROTTLE_C || pastTarget(tightest)) return Confidence.MEDIUM;
    return Confidence.LOW;
}

/**
 * One sensor's distance from its own trip point, in words.
 *
 * Two shapes, because a sensor is read one of two ways. An unlabelled channel is
 * the number already on the panel, so its line says only the distance. A labelled
 * one is a sensor the user cannot see, and its line has to stand on its own
 * beside a panel showing something lower — so it names the channel and its
 * reading, and says "its" throttle point, which is the one that governs it.
 *
 * A machine past its thermal target gets one more clause, and it is worded to
 * be unmistakable for a second trip point: "aims to hold" is what the platform
 * does about that number, and throttling is what it does about the other one.
 *
 * @param {{label: string|null, tempC: number, throttlePointC: number,
 *          targetC?: number|null}} sensor
 * @returns {string}
 */
export function describeHeadroom(sensor) {
    const {label, tempC, throttlePointC} = sensor;
    const headroom = throttlePointC - tempC;
    const target = pastTarget(sensor)
        ? ` and past the ${sensor.targetC}°C it aims to hold`
        : '';

    if (label === null) {
        return headroom <= 0
            ? `At the throttle point (${throttlePointC}°C)${target}`
            : `${headroom}°C below the throttle point (${throttlePointC}°C)${target}`;
    }
    return headroom <= 0
        ? `${label} at its throttle point (${throttlePointC}°C)${target}`
        : `${label} at ${tempC}°C, ${headroom}°C below its throttle point `
            + `(${throttlePointC}°C)${target}`;
}

/**
 * The verdict a set of sensors earns on temperature alone.
 *
 * Two questions, kept apart and then combined by taking the worse of them. The
 * hardware knows where it throttles — `tempN_crit` is TjMax on `coretemp`, the
 * HTC trip on `k10temp`, the critical max on `amdgpu` — and headroom below that
 * is a fact. The two settings are a preference: "tell me above 88°C" is a
 * reasonable thing to want and a meaningless thing to call evidence, because
 * 88 °C is twelve degrees of headroom on one part and two degrees past the trip
 * point on another.
 *
 * So the wording says which of the two spoke. Attributing a level the hardware
 * did not ask for to the person who did is the whole reason both are evaluated
 * rather than one: this project once described a number the user had typed in
 * the language of evidence, and called it "throttle imminent".
 *
 * Every temperature-only rule goes through here, so a `coretemp` core and an
 * `amdgpu` junction channel are judged and worded alike. The caller decides only
 * what the preference is measured against — the CPU has a number on the panel
 * and compares that, a GPU has none and compares its own tightest channel — and
 * what else belongs in the line.
 *
 * @param {ReturnType<typeof tightestSensor>} tightest
 * @param {number|null} preferenceTempC  What the user's thresholds judge.
 * @param {import('./thresholds.js').Thresholds} thresholds
 * @returns {{level: import('./confidence.js').Level, clauses: string[]}}
 *   `clauses` are this tier's parts of the detail line, in order, with the
 *   unsayable ones already dropped.
 */
export function assessHeadroom(tightest, preferenceTempC, thresholds) {
    const hardware = temperatureLevel(tightest);
    const user = thresholds.isCritical(preferenceTempC) ? Confidence.HIGH
        : thresholds.isWarm(preferenceTempC) ? Confidence.MEDIUM
            : Confidence.LOW;

    return {
        level: worstOf([hardware, user]),
        clauses: [
            // Say the headroom whenever it is known, at every level: "18°C below
            // the throttle point" is the most useful thing this tier can report,
            // and it is true whether or not anything is wrong.
            tightest === null ? null : describeHeadroom(tightest),
            !isWorse(user, hardware) ? null
                : user === Confidence.HIGH ? 'above your critical threshold'
                    : 'above your warning threshold',
        ].filter(Boolean),
    };
}
