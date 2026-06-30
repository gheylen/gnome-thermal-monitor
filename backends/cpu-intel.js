// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel CPU thermal throttle backend.
//
// Primary signal: core_throttle_total_time_ms — a per-core kernel counter that
// increments only on hardware PROCHOT interrupts.  readState reads one counter
// per core; lib/conf-cpu.js diffs them against the previous poll and reports how
// many cores throttled in the interval (a definitive, hardware-confirmed event).
//
// Temperature: coretemp hwmon "Package id 0" (preferred) or the x86_pkg_temp
// thermal zone (fallback).
//
// Confidence: CONFIRMED when one or more cores' PROCHOT counters advanced;
// HIGH / MEDIUM / LOW based on temperature when no core throttled.
//
// Contributes context.cpuTempC so GPU and NPU backends can infer thermal cause.

import {readFile, listDir, parseIntSafe} from '../lib/sysfs.js';
import {cpuConf} from '../lib/conf-cpu.js';

// ── Discovery ──────────────────────────────────────────────────────────────────

function discoverHw() {
    const throttlePaths = [];
    for (const entry of listDir('/sys/devices/system/cpu')) {
        if (!/^cpu\d+$/.test(entry)) continue;
        const base = `/sys/devices/system/cpu/${entry}/thermal_throttle`;
        if (readFile(`${base}/core_throttle_total_time_ms`) !== null)
            throttlePaths.push(base);
    }

    // Prefer coretemp hwmon "Package id 0" for the package temperature.
    let tempSensor = null;
    outer:
    for (const name of listDir('/sys/class/hwmon')) {
        const base = `/sys/class/hwmon/${name}`;
        if (readFile(`${base}/name`) !== 'coretemp') continue;
        for (const f of listDir(base)) {
            if (!f.endsWith('_label')) continue;
            if (readFile(`${base}/${f}`) !== 'Package id 0') continue;
            const pfx = f.replace('_label', '');
            tempSensor = {path: `${base}/${pfx}_input`}; // millidegrees Celsius
            break outer;
        }
    }

    // Fallback: x86_pkg_temp thermal zone (zone index varies by platform).
    if (!tempSensor) {
        for (let i = 0; i < 32; i++) {
            if (readFile(`/sys/class/thermal/thermal_zone${i}/type`) !== 'x86_pkg_temp')
                continue;
            tempSensor = {path: `/sys/class/thermal/thermal_zone${i}/temp`};
            break;
        }
    }

    if (throttlePaths.length === 0 && !tempSensor) return null;
    return {throttlePaths, tempSensor};
}

// ── State reader ───────────────────────────────────────────────────────────────

function readState(hw) {
    // One counter per core; null for any core whose counter can't be read.
    // The array length is stable across polls (paths are fixed at discovery),
    // so conf-cpu can compare cores by index.
    const throttleTimes = hw.throttlePaths.map(
        base => parseIntSafe(readFile(`${base}/core_throttle_total_time_ms`))
    );
    let tempC = null;
    if (hw.tempSensor) {
        const raw = parseIntSafe(readFile(hw.tempSensor.path));
        tempC = raw !== null ? Math.round(raw / 1000) : null;
    }
    return {throttleTimes, tempC};
}

// Confidence logic lives in lib/conf-cpu.js (pure, unit-tested).

// ── Backend export ─────────────────────────────────────────────────────────────

export default {
    name:     'Intel CPU',
    category: 'cpu',

    discover() {
        const hw = discoverHw();
        if (!hw) return [];
        return [{
            id:           'cpu',
            sectionTitle: 'CPU',
            readState:          () => readState(hw),
            calcConf:           (state, prevState, ctx) => cpuConf(state, prevState, ctx),
            contributeContext:  (state, ctx) => { ctx.cpuTempC = state?.tempC ?? null; },
        }];
    },
};
