// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure confidence logic for the Intel CPU backend.
//
// The headline signal is the number of cores whose per-core PROCHOT counter
// (core_throttle_total_time_ms) advanced since the previous poll — a definitive,
// hardware-confirmed throttle event. When no core throttled, confidence falls
// back to the package temperature thresholds.
//
// state: { throttleTimes: (number|null)[]  per-core counters in ms,
//          tempC: number|null }
// No sysfs / gi:// access, so it is unit-testable.

import {Confidence} from './confidence.js';

// Count cores whose counter strictly advanced. Only compares when both polls
// have a numeric reading for that core and the arrays line up 1:1 (a length
// change means the CPU topology was re-read — treat as no reliable delta).
function countThrottlingCores(cur, prev) {
    if (!prev || cur.length !== prev.length) return 0;
    let n = 0;
    for (let i = 0; i < cur.length; i++) {
        const a = cur[i], b = prev[i];
        if (a !== null && b !== null && a > b) n++;
    }
    return n;
}

export function cpuConf(state, prevState, context) {
    if (!state)
        return {level: Confidence.UNKNOWN, line1: 'CPU — no data', line2: ''};

    const {tempWarn, tempCrit} = context;
    const tempStr     = state.tempC !== null ? `${state.tempC}°C` : '?°C';
    const totalCores  = state.throttleTimes.length;
    const throttling  = countThrottlingCores(state.throttleTimes, prevState?.throttleTimes ?? null);

    if (throttling > 0)
        return {
            level:       Confidence.CONFIRMED,
            line1:       `CPU Package  ${tempStr}`,
            line2:       `${throttling} of ${totalCores} cores throttling — PROCHOT`,
            panelSuffix: ` (${throttling})`,
        };

    if (state.tempC !== null && state.tempC >= tempCrit)
        return {
            level: Confidence.HIGH,
            line1: `CPU Package  ${tempStr}`,
            line2: `At critical threshold — throttle imminent`,
        };

    if (state.tempC !== null && state.tempC >= tempWarn)
        return {
            level: Confidence.MEDIUM,
            line1: `CPU Package  ${tempStr}`,
            line2: `Elevated — approaching throttle`,
        };

    return {
        level: Confidence.LOW,
        line1: `CPU Package  ${tempStr}`,
        line2: `Nominal`,
    };
}
