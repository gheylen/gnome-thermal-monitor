// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel HD / Iris / UHD GPU adapter (i915 kernel driver).
//
// i915 hangs its sysfs off the DRM primary node, not off the PCI device:
// `intel_gt_sysfs.c:gt_get_parent_obj()` returns
// `&gt->i915->drm.primary->kdev->kobj`, i.e. /sys/class/drm/cardN/. That is the
// difference from xe, which attaches `tile%d` straight to the PCI device
// (`xe_tile_sysfs.c`). Building i915's paths the way xe's are built finds
// nothing at all, on any machine.
//
// Two layouts, and they differ in more than their location:
//
//   Per-GT   /sys/class/drm/cardN/gt/gtM/rps_{act,cur,max,RP0}_freq_mhz
//            plus throttle_reason_{status,prochot,thermal,…} on Gen11+.
//            `intel_gt_sysfs_pm.c` builds these with `__ATTR(rps_##_name, …)`
//            and registers the reason files only for a real GT object.
//   Legacy   /sys/class/drm/cardN/gt_{act,cur,max,RP0}_freq_mhz
//            The same values under the device itself, from
//            `__ATTR(gt_##_name, …)`. No throttle reasons.
//
// Note the capitalised RP0 in both spellings, and `rps_` rather than a bare
// name in the per-GT one.

import {assessGpu} from '../domain/gpu.js';
import {firstThermalReason} from './gpu-reasons.js';

const DRM_ROOT = '/sys/class/drm';
const DRIVER = 'i915';

/**
 * The frequency attribute names differ between the two layouts, and `RP0` is
 * capitalised in both.
 *
 * @param {{freqDir: string, perGt: boolean}} gt
 * @param {'act'|'cur'|'max'|'min'|'RP0'} name
 * @returns {string}
 */
const frequencyPath = ({freqDir, perGt}, name) =>
    `${freqDir}/${perGt ? 'rps' : 'gt'}_${name}_freq_mhz`;

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {{label: string, freqDir: string, perGt: boolean}[]}
 */
function findGts(sysfs) {
    const gts = [];
    for (const entry of sysfs.list(DRM_ROOT)) {
        // /sys/class/drm also holds connector nodes like card0-eDP-1.
        if (!/^card\d+$/.test(entry)) continue;
        const card = `${DRM_ROOT}/${entry}`;
        if (sysfs.driverOf(`${card}/device`) !== DRIVER) continue;

        const before = gts.length;
        for (const gt of sysfs.list(`${card}/gt`).filter(name => /^gt\d+$/.test(name))) {
            const candidate = {label: gt, freqDir: `${card}/gt/${gt}`, perGt: true};
            // Hold discovery to the bar the rule applies: a ceiling that is
            // present but unreadable or zero would give a section that says "no
            // data" for ever, while still counting as a GPU found and so
            // suppressing the "no supported GPU" warning.
            if (sysfs.readInt(frequencyPath(candidate, 'RP0')) > 0) gts.push(candidate);
        }

        // Only fall back to the legacy layout for a card that offered no GTs.
        const legacy = {label: 'GT', freqDir: card, perGt: false};
        if (gts.length === before && sysfs.readInt(frequencyPath(legacy, 'RP0')) > 0)
            gts.push(legacy);
    }
    return gts;
}

/**
 * Read one GT.  Unlike xe, this can ask whether the GPU is busy without waking
 * it, and the whole shape of this function depends on that.
 *
 * Verified in `intel_rps.c`:
 *
 *   act_freq_mhz   `intel_rps_read_actual_frequency()` — `with_intel_runtime_pm
 *                  _if_in_use`, so a suspended device answers 0 and stays
 *                  suspended.  That 0 is what `idle` is read from.
 *   cur/max/RP0    software fields (`rps->cur_freq`, `max_freq_softlimit`,
 *                  `rp0_freq`), or `_if_in_use` again under SLPC.  No resume.
 *   throttle_*     `rps_read_mask_mmio()` → `rps_read_mmio()` — plain
 *                  `with_intel_runtime_pm`, which *does* resume.
 *
 * So skipping the reason files on a parked GT genuinely avoids the wake here:
 * everything read before that decision leaves the device alone.  In xe the
 * equivalent skip cannot work, because every attribute that could answer the
 * question resumes the device first — see `gpu-xe.js`, which asks the PM core
 * instead.  The two adapters look different because the drivers are, and
 * making them match would break one of them.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {{freqDir: string, perGt: boolean}} gt
 * @returns {import('../domain/gpu.js').GpuReading}
 */
function read(sysfs, gt) {
    const frequency = name => sysfs.readInt(frequencyPath(gt, name));
    const throttleReason = name =>
        gt.perGt ? sysfs.readInt(`${gt.freqDir}/throttle_reason_${name}`) : null;

    // The clock the GPU is actually running at: 0 when the engines are parked,
    // and 0 when the device is runtime-suspended, which for our purposes is the
    // same answer arrived at without a wake.
    const idle = frequency('act') === 0;

    // `throttle_reason_status` carries `GT0_PERF_LIMIT_REASONS_MASK`, which is
    // 0xde3 — bits 0, 1, 5, 6, 7, 8, 10 and 11, exactly the set the individual
    // `throttle_reason_*` attributes each pick one bit out of.  A status of 0 is
    // therefore every reason being 0, established by the same register read, so
    // reading them again would be eight more MMIO reads (each through
    // `with_intel_runtime_pm`) of a question already answered.
    //
    // Skipped when parked for the other reason: a parked engine is not
    // throttling, and these are the only reads in this adapter that would resume
    // a suspended GPU.
    const status = idle ? null : throttleReason('status');
    const reason = name => idle || status === 0 ? null : throttleReason(name);

    return {
        currentMhz: frequency('cur'),
        maxMhz: frequency('max'),
        rp0Mhz: frequency('RP0'),
        idle,
        // Nothing below this is published by the legacy layout, and the reason
        // files only exist on Gen11+ even per-GT; all of it reads null there.
        throttled: status,
        thermalReason: firstThermalReason(reason),
        prochot: reason('prochot'),
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'Intel i915 GPU',
    category: 'gpu',

    discover(sysfs) {
        return findGts(sysfs).map((gt, index) => ({
            id: `gpu:i915:${index}`,
            title: `GPU — ${gt.label}`,
            read: () => read(sysfs, gt),
            assess: assessGpu,
        }));
    },
};
