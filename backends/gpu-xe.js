// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel Arc / Xe iGPU backend (xe kernel driver).
//
// Discovers one component per GT (Graphics Tile).  Lunar Lake and Meteor Lake
// expose two GTs: a render engine (gt0-rc) and a media/codec engine (gt1-mc).
//
// Primary signal: freq0/throttle/ directory (xe does expose per-GT throttle
// reasons: reason_thermal, reason_prochot, status, reasons string).  Secondary
// signal: max_freq vs rp0_freq — when the driver hard-caps max_freq below the
// hardware maximum (RP0) without an active throttle register, thermal cause is
// inferred from the CPU package temperature.

import {readFile, listDir, readDriverName, parseIntSafe} from '../lib/sysfs.js';
import {gpuXeConf} from '../lib/conf-gpu-xe.js';

// ── Discovery ──────────────────────────────────────────────────────────────────

function discoverGts() {
    const gts = [];
    for (const dev of listDir('/sys/bus/pci/devices')) {
        const devPath = `/sys/bus/pci/devices/${dev}`;
        if (readDriverName(devPath) !== 'xe') continue;
        for (const tile of listDir(devPath).filter(n => /^tile\d+$/.test(n))) {
            const tilePath = `${devPath}/${tile}`;
            for (const gt of listDir(tilePath).filter(n => /^gt\d+$/.test(n))) {
                const freqDir  = `${tilePath}/${gt}/freq0`;
                const idlePath = `${tilePath}/${gt}/gtidle/idle_status`;
                if (readFile(`${freqDir}/rp0_freq`) === null) continue;
                const roleName = readFile(`${tilePath}/${gt}/gtidle/name`) ?? gt;
                const label = roleName.includes('-mc') ? 'Media/Codec'
                    : roleName.includes('-rc') ? 'Render' : roleName;
                gts.push({label, freqDir, idlePath, throttleDir: `${freqDir}/throttle`});
            }
        }
    }
    return gts;
}

// ── State reader ───────────────────────────────────────────────────────────────

function readState(gt) {
    const key        = name => `${gt.freqDir}/${name}_freq`;
    const actFreq    = parseIntSafe(readFile(key('act')));
    const curFreq    = parseIntSafe(readFile(key('cur')));
    const maxFreq    = parseIntSafe(readFile(key('max')));
    const rp0Freq    = parseIntSafe(readFile(key('rp0')));
    const idleStatus     = readFile(gt.idlePath);
    const isIdle         = actFreq === 0 ||
        (idleStatus !== null && idleStatus.toLowerCase().includes('c6'));
    const throttleStatus = parseIntSafe(readFile(`${gt.throttleDir}/status`));
    const reasonThermal  = parseIntSafe(readFile(`${gt.throttleDir}/reason_thermal`));
    const reasonProchot  = parseIntSafe(readFile(`${gt.throttleDir}/reason_prochot`));
    const reasons        = readFile(`${gt.throttleDir}/reasons`);
    return {actFreq, curFreq, maxFreq, rp0Freq, isIdle, throttleStatus, reasonThermal, reasonProchot, reasons};
}

// Confidence logic lives in lib/conf-gpu-xe.js (pure, unit-tested).

// ── Backend export ─────────────────────────────────────────────────────────────

export default {
    name:     'Intel Xe GPU',
    category: 'igpu',
    // No per-backend empty warning — the 'igpu' entry in CATEGORY_WARNINGS (index.js) fires once.

    discover() {
        return discoverGts().map((gt, i) => ({
            id:           `gpu-xe-${i}`,
            sectionTitle: `iGPU — ${gt.label}`,
            readState:    () => readState(gt),
            calcConf:     (state, _prevState, ctx) => gpuXeConf(state, gt.label, ctx),
        }));
    },
};
