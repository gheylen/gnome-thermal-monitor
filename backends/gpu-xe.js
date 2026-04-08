// Intel Arc / Xe iGPU backend (xe kernel driver).
//
// Discovers one component per GT (Graphics Tile).  Lunar Lake and Meteor Lake
// expose two GTs: a render engine (gt0-rc) and a media/codec engine (gt1-mc).
//
// Primary signal: max_freq vs rp0_freq.  When the driver hard-caps max_freq
// below the hardware maximum (RP0), the GPU is being throttled.  The xe driver
// does not expose a throttle-reason file, so thermal cause is inferred from the
// CPU package temperature.

import {readFile, listDir, readDriverName, parseIntSafe} from '../lib/sysfs.js';
import {Confidence} from '../lib/confidence.js';

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
                gts.push({label, freqDir, idlePath});
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
    const idleStatus = readFile(gt.idlePath);
    const isIdle     = actFreq === 0 ||
        (idleStatus !== null && idleStatus.toLowerCase().includes('c6'));
    return {actFreq, curFreq, maxFreq, rp0Freq, isIdle};
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

    // Hard cap: driver reduced max_freq below the hardware maximum (RP0).
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
    name:     'Intel Xe GPU',
    category: 'igpu',
    // No per-backend empty warning — the 'igpu' entry in CATEGORY_WARNINGS (index.js) fires once.

    discover() {
        return discoverGts().map((gt, i) => ({
            id:           `gpu-xe-${i}`,
            sectionTitle: `iGPU — ${gt.label}`,
            readState:    () => readState(gt),
            calcConf:     (state, prevState, ctx) => calcConf(state, prevState, gt.label, ctx),
        }));
    },
};
