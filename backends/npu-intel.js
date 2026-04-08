// Intel NPU (VPU) backend — Core Ultra (Meteor Lake) and later.
//
// Identified by the npu_* sysfs attributes under /sys/class/accel/accel*/device/.
// Requires the intel_vpu kernel module (mainline since kernel 6.8).
//
// No thermal-specific counter exists for the NPU.  The only available signal is
// the frequency ratio: if the NPU is running below its maximum frequency while
// active, throttling may be occurring.  Confidence is capped at LOW.

import {readFile, listDir, parseIntSafe} from '../lib/sysfs.js';
import {Confidence} from '../lib/confidence.js';

// ── Discovery ──────────────────────────────────────────────────────────────────

function discoverHw() {
    for (const accel of listDir('/sys/class/accel')) {
        const devPath = `/sys/class/accel/${accel}/device`;
        if (readFile(`${devPath}/npu_current_frequency_mhz`) !== null)
            return {devPath};
    }
    return null;
}

// ── State reader ───────────────────────────────────────────────────────────────

function readState(hw) {
    return {
        curFreq: parseIntSafe(readFile(`${hw.devPath}/npu_current_frequency_mhz`)),
        maxFreq: parseIntSafe(readFile(`${hw.devPath}/npu_max_frequency_mhz`)),
        busyUs:  parseIntSafe(readFile(`${hw.devPath}/npu_busy_time_us`)),
    };
}

// ── Confidence calculator ──────────────────────────────────────────────────────

function calcConf(state, prevState, context) {
    if (!state || state.curFreq === null || state.maxFreq === null || state.maxFreq === 0)
        return {level: Confidence.UNKNOWN, line1: 'NPU — no data', line2: ''};

    const prevBusyUs = prevState?.busyUs ?? null;
    // Clamp to 0: a negative delta means the counter reset (e.g. suspend/resume).
    const busyDelta  = (state.busyUs !== null && prevBusyUs !== null)
        ? Math.max(0, state.busyUs - prevBusyUs) : 0;
    const isActive   = state.curFreq > 0;

    if (!isActive || busyDelta === 0)
        return {
            level: Confidence.IDLE,
            line1: `NPU  idle`,
            line2: `${state.curFreq} / ${state.maxFreq} MHz`,
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

// ── Backend export ─────────────────────────────────────────────────────────────

export default {
    name:     'Intel NPU',
    category: 'npu',

    discover() {
        const hw = discoverHw();
        if (!hw) return [];
        return [{
            id:           'npu',
            sectionTitle: 'NPU',
            readState:    () => readState(hw),
            calcConf:     (state, prevState, ctx) => calcConf(state, prevState, ctx),
        }];
    },
};
