// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel NPU (VPU) backend — Core Ultra (Meteor Lake) and later.
//
// Identified by the npu_* sysfs attributes under /sys/class/accel/accel*/device/.
// Requires the intel_vpu kernel module (mainline since kernel 6.8).
//
// No thermal-specific counter exists for the NPU.  The only available signal is
// the frequency ratio: if the NPU is running below its maximum frequency while
// active, throttling may be occurring.  Confidence is capped at LOW.

import {readFile, listDir, parseIntSafe} from '../lib/sysfs.js';
import {npuConf} from '../lib/conf-npu.js';

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

// Confidence logic lives in lib/conf-npu.js (pure, unit-tested).

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
            calcConf:     (state, prevState, ctx) => npuConf(state, prevState, ctx),
        }];
    },
};
