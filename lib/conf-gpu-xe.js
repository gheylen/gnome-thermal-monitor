// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure confidence logic for the Intel xe iGPU backend.
// Receives a plain state object (read by backends/gpu-xe.js) and returns a
// confidence verdict. No sysfs / gi:// access, so it is unit-testable.

import {Confidence} from './confidence.js';
import {calcFreqConf} from './gpu-common.js';

export function gpuXeConf(state, label, context) {
    if (!state || state.rp0Freq === null)
        return {level: Confidence.UNKNOWN, line1: `iGPU ${label} — no data`, line2: ''};

    const {curFreq, maxFreq, rp0Freq, isIdle, throttleStatus, reasonThermal, reasonProchot, reasons} = state;
    const {cpuTempC, tempWarn} = context;
    const freqStr = `${curFreq ?? '?'} / ${rp0Freq} MHz`;

    if (isIdle)
        return {level: Confidence.IDLE, line1: `iGPU ${label}  idle`, line2: freqStr};

    // Direct xe throttle signals from freq0/throttle/.
    if (reasonProchot === 1)
        return {
            level: Confidence.CONFIRMED,
            line1: `iGPU ${label}  throttled`,
            line2: `${freqStr} — PROCHOT`,
        };

    if (reasonThermal === 1)
        return {
            level: Confidence.HIGH,
            line1: `iGPU ${label}  throttled`,
            line2: `${freqStr} — thermal`,
        };

    if (throttleStatus === 1) {
        const reasonStr = (reasons && reasons !== 'none') ? reasons : 'unknown';
        return {
            level: Confidence.MEDIUM,
            line1: `iGPU ${label}  throttled`,
            line2: `${freqStr} — ${reasonStr}`,
        };
    }

    // Hard cap without an active throttle register: driver-side limit or stale cap.
    return calcFreqConf(label, curFreq, maxFreq, rp0Freq, freqStr, cpuTempC, tempWarn);
}
