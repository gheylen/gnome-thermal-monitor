// Intel CPU thermal throttle backend.
//
// Primary signal: core_throttle_total_time_ms — a per-core kernel counter that
// increments only on hardware PROCHOT interrupts.  Summed across all cores and
// diffed against the previous poll, it gives an exact throttle duty-cycle.
//
// Temperature: coretemp hwmon "Package id 0" (preferred) or the x86_pkg_temp
// thermal zone (fallback).
//
// Confidence: CONFIRMED when the PROCHOT counter advanced; HIGH / MEDIUM / LOW
// based on temperature when no interrupt fired.
//
// Contributes context.cpuTempC so GPU and NPU backends can infer thermal cause.

import {readFile, listDir, parseIntSafe} from '../lib/sysfs.js';
import {Confidence} from '../lib/confidence.js';

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
    let throttleTimeMs = 0;
    for (const base of hw.throttlePaths) {
        const v = parseIntSafe(readFile(`${base}/core_throttle_total_time_ms`));
        if (v !== null) throttleTimeMs += v;
    }
    let tempC = null;
    if (hw.tempSensor) {
        const raw = parseIntSafe(readFile(hw.tempSensor.path));
        tempC = raw !== null ? Math.round(raw / 1000) : null;
    }
    return {throttleTimeMs, tempC};
}

// ── Confidence calculator ──────────────────────────────────────────────────────

function calcConf(state, prevState, context) {
    if (!state)
        return {level: Confidence.UNKNOWN, line1: 'CPU — no data', line2: ''};

    const {pollMs, tempWarn, tempCrit} = context;
    const tempStr    = state.tempC !== null ? `${state.tempC}°C` : '?°C';
    const prevMs    = prevState?.throttleTimeMs ?? state.throttleTimeMs;
    // Clamp to 0: a negative delta means the counter reset (e.g. suspend/resume).
    const timeDelta = Math.max(0, state.throttleTimeMs - prevMs);

    if (timeDelta > 0) {
        const pct = pollMs > 0 ? Math.min(Math.round(timeDelta * 100 / pollMs), 100) : 0;
        return {
            level:       Confidence.CONFIRMED,
            line1:       `CPU Package  ${tempStr}`,
            line2:       `Throttled ${pct}% of last poll — PROCHOT`,
            panelSuffix: ` ${pct}%`,
        };
    }

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
            calcConf:           (state, prevState, ctx) => calcConf(state, prevState, ctx),
            contributeContext:  (state, ctx) => { ctx.cpuTempC = state?.tempC ?? null; },
        }];
    },
};
