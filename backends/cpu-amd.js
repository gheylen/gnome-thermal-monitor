// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// AMD CPU thermal backend (k10temp driver) — EXPERIMENTAL.
//
// AMD does not expose a per-core PROCHOT-style "confirmed throttle" counter the
// way Intel does, so this backend is temperature-only: it reads the package
// control temperature from k10temp and reports HIGH / MEDIUM / LOW against the
// user's thresholds. It can never report CONFIRMED — that would overstate what
// the hardware actually tells us.
//
// It reuses the pure decision logic in lib/conf-cpu.js by feeding an empty
// per-core array (no cores can "throttle"), so confidence falls through to the
// temperature thresholds, capped at HIGH.
//
// Sensor preference: Tctl (the control temperature the platform throttles on)
// → Tdie (actual die temperature) → the first available temperature input.
//
// NOTE: discovery and readState below are written from documented k10temp sysfs
// layout and have NOT been validated on real AMD hardware. Reports from AMD
// users are welcome (see CONTRIBUTING.md).

import {readFile, listDir, parseIntSafe} from '../lib/sysfs.js';
import {cpuConf} from '../lib/conf-cpu.js';

// ── Discovery ──────────────────────────────────────────────────────────────────

function discoverHw() {
    for (const name of listDir('/sys/class/hwmon')) {
        const base = `/sys/class/hwmon/${name}`;
        if (readFile(`${base}/name`) !== 'k10temp') continue;

        // Map each tempN_label → tempN_input, then pick by preference.
        const byLabel = {};
        let firstInput = null;
        for (const f of listDir(base)) {
            if (!f.endsWith('_label')) continue;
            const pfx   = f.replace('_label', '');
            const input = `${base}/${pfx}_input`;
            if (readFile(input) === null) continue;
            firstInput ??= input;
            const label = readFile(`${base}/${f}`);
            if (label !== null) byLabel[label] = input;
        }
        // Some k10temp versions expose no labels — fall back to temp1_input.
        if (firstInput === null && readFile(`${base}/temp1_input`) !== null)
            firstInput = `${base}/temp1_input`;

        const tempPath = byLabel['Tctl'] ?? byLabel['Tdie'] ?? firstInput;
        if (tempPath) return {tempPath};
    }
    return null;
}

// ── State reader ───────────────────────────────────────────────────────────────

function readState(hw) {
    const raw = parseIntSafe(readFile(hw.tempPath));
    const tempC = raw !== null ? Math.round(raw / 1000) : null;
    // Empty cores array: AMD has no confirmed-throttle counter, so conf-cpu
    // reports purely on temperature and never escalates to CONFIRMED.
    return {throttleTimes: [], tempC};
}

// ── Backend export ─────────────────────────────────────────────────────────────

export default {
    name:     'AMD CPU',
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
