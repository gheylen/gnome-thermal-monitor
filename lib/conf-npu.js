// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure confidence logic for the Intel NPU backend.
// Receives a plain state object (read by backends/npu-intel.js) and returns a
// confidence verdict. No sysfs / gi:// access, so it is unit-testable.

import {Confidence} from './confidence.js';

export function npuConf(state, prevState, context) {
    if (!state || state.curFreq === null || state.maxFreq === null || state.maxFreq === 0)
        return {level: Confidence.UNKNOWN, line1: 'NPU — no data', line2: ''};

    const prevBusyUs = prevState?.busyUs ?? null;
    // Clamp to 0: a negative delta means the counter reset (e.g. suspend/resume).
    const busyDelta  = (state.busyUs !== null && prevBusyUs !== null)
        ? Math.max(0, state.busyUs - prevBusyUs) : 0;
    const isActive   = state.curFreq > 0;

    if (!isActive)
        return {
            level: Confidence.IDLE,
            line1: `NPU  idle`,
            line2: `${state.curFreq} / ${state.maxFreq} MHz`,
        };

    // NPU running but busy counter unreadable — cannot determine activity level.
    if (state.busyUs === null)
        return {level: Confidence.UNKNOWN, line1: 'NPU — no data', line2: ''};

    if (busyDelta === 0)
        return {
            level: Confidence.LOW,
            line1: `NPU  active`,
            line2: `${state.curFreq} / ${state.maxFreq} MHz — no new work this interval`,
        };

    const pct = Math.round(state.curFreq * 100 / state.maxFreq);
    if (pct >= 85)
        return {
            level: Confidence.LOW,
            line1: `NPU  active`,
            line2: `${state.curFreq} / ${state.maxFreq} MHz — nominal`,
        };

    const {cpuTempC, tempWarn} = context;
    const packageHot = cpuTempC !== null && cpuTempC >= tempWarn;
    return {
        level: Confidence.LOW,
        line1: `NPU  active`,
        line2: `${state.curFreq} / ${state.maxFreq} MHz (${pct}%)` +
               `${packageHot ? ' — thermal unconfirmed' : ''}`,
    };
}
