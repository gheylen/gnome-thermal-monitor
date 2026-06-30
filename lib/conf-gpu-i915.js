// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure confidence logic for the Intel i915 iGPU backend.
// i915 exposes no throttle-reason file, so thermal cause is inferred purely
// from the frequency cap and the CPU package temperature (lib/gpu-common.js).
// No sysfs / gi:// access, so it is unit-testable.

import {Confidence} from './confidence.js';
import {calcFreqConf} from './gpu-common.js';

export function gpuI915Conf(state, label, context) {
    if (!state || state.rp0Freq === null)
        return {level: Confidence.UNKNOWN, line1: `iGPU ${label} — no data`, line2: ''};

    const {curFreq, maxFreq, rp0Freq, isIdle} = state;
    const {cpuTempC, tempWarn} = context;
    const freqStr = `${curFreq ?? '?'} / ${rp0Freq} MHz`;

    if (isIdle)
        return {level: Confidence.IDLE, line1: `iGPU ${label}  idle`, line2: freqStr};

    return calcFreqConf(label, curFreq, maxFreq, rp0Freq, freqStr, cpuTempC, tempWarn);
}
