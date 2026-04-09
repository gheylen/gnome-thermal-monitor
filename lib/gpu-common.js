// Shared confidence logic for iGPU backends (xe and i915).
// Called after backend-specific throttle checks; handles the common
// freq-cap and below-max cases that both drivers share.

import {Confidence} from './confidence.js';

// Returns a confidence object for the hard-cap / below-max / nominal cases.
// Callers should only reach this if no direct throttle signal was detected.
export function calcFreqConf(label, curFreq, maxFreq, rp0Freq, freqStr, cpuTempC, tempWarn) {
    if (rp0Freq === null)
        return {level: Confidence.UNKNOWN, line1: `iGPU ${label}  no boost freq`, line2: freqStr ?? ''};

    if (maxFreq !== null && maxFreq < rp0Freq * 0.95) {
        const packageHot = cpuTempC !== null && cpuTempC >= tempWarn;
        return {
            level: packageHot ? Confidence.HIGH : Confidence.MEDIUM,
            line1: `iGPU ${label}  freq capped`,
            line2: `${maxFreq}/${rp0Freq} MHz cap${packageHot ? ' — package hot' : ' — reason unknown'}`,
        };
    }

    if (curFreq !== null && curFreq < rp0Freq * 0.75)
        return {
            level: Confidence.LOW,
            line1: `iGPU ${label}  below max`,
            line2: `${freqStr} — P-state or power limit`,
        };

    return {level: Confidence.LOW, line1: `iGPU ${label}  nominal`, line2: freqStr};
}
