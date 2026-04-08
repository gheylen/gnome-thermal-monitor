// Intel HD / Iris / UHD iGPU backend (i915 kernel driver).
//
// Fallback for pre-Arc Intel GPUs.  Handles two sysfs layouts:
//   Modern: <device>/gt/gt0/act_freq_mhz  (kernel 5.x+)
//   Flat:   <device>/gt_cur_freq_mhz      (older kernels, uppercase RP0/RPn)
//
// The i915 driver does not expose a throttle-reason file; thermal cause is
// inferred from the CPU package temperature (same logic as the xe backend).

import {readFile, listDir, readDriverName, parseIntSafe} from '../lib/sysfs.js';
import {Confidence} from '../lib/confidence.js';

// ── Discovery ──────────────────────────────────────────────────────────────────

function discoverGts() {
    const gts = [];
    for (const dev of listDir('/sys/bus/pci/devices')) {
        const devPath = `/sys/bus/pci/devices/${dev}`;
        if (readDriverName(devPath) !== 'i915') continue;
        const prevLen = gts.length;
        // Modern layout: <device>/gt/gt0/
        for (const gt of listDir(`${devPath}/gt`).filter(n => /^gt\d+$/.test(n))) {
            const freqDir = `${devPath}/gt/${gt}`;
            if (readFile(`${freqDir}/rp0_freq_mhz`) !== null)
                gts.push({label: gt, freqDir, i915Modern: true});
        }
        // Legacy flat layout: <device>/gt_cur_freq_mhz etc.
        if (gts.length === prevLen && readFile(`${devPath}/gt_cur_freq_mhz`) !== null)
            gts.push({label: 'GT', freqDir: devPath, i915Flat: true});
    }
    return gts;
}

// ── State reader ───────────────────────────────────────────────────────────────

function readState(gt) {
    const key = name => {
        if (gt.i915Modern) return `${gt.freqDir}/${name}_freq_mhz`;
        // Flat layout uses uppercase RP0 / RPn filenames.
        const sysfsName = name === 'rp0' ? 'RP0' : name === 'rpn' ? 'RPn' : name;
        return `${gt.freqDir}/gt_${sysfsName}_freq_mhz`;
    };

    const curFreq = parseIntSafe(readFile(key('cur')));
    const maxFreq = parseIntSafe(readFile(key('max')));
    const rp0Freq = parseIntSafe(readFile(key('rp0')));
    // Modern layout has act_freq; flat layout does not — use cur == min as idle proxy.
    const actFreq = gt.i915Modern ? parseIntSafe(readFile(key('act'))) : null;
    const minFreq = gt.i915Flat   ? parseIntSafe(readFile(key('min'))) : null;
    const isIdle  = actFreq === 0 ||
        (gt.i915Flat && minFreq !== null && curFreq === minFreq);
    return {curFreq, maxFreq, rp0Freq, isIdle};
}

// ── Confidence calculator ──────────────────────────────────────────────────────

function calcConf(state, _prevState, label, context) {
    if (!state || state.rp0Freq === null)
        return {level: Confidence.UNKNOWN, line1: `iGPU ${label} — no data`, line2: ''};

    const {curFreq, maxFreq, rp0Freq, isIdle} = state;
    const {cpuTempC, tempWarn} = context;
    const freqStr = `${curFreq ?? '?'} / ${rp0Freq} MHz`;

    if (isIdle)
        return {level: Confidence.IDLE, line1: `iGPU ${label}  idle`, line2: freqStr};

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

// ── Backend export ─────────────────────────────────────────────────────────────

export default {
    name:     'Intel i915 GPU',
    category: 'igpu',
    // This backend provides the category-level warning if no iGPU is found at all.

    discover() {
        return discoverGts().map((gt, i) => ({
            id:           `gpu-i915-${i}`,
            sectionTitle: `iGPU — ${gt.label}`,
            readState:    () => readState(gt),
            calcConf:     (state, prevState, ctx) => calcConf(state, prevState, gt.label, ctx),
        }));
    },
};
