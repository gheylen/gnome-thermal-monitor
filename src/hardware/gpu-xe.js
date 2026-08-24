// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel Arc / Xe GPU adapter (xe kernel driver).
//
// One component per GT (graphics tile).  Lunar Lake and Meteor Lake expose two:
// a render engine (`gt0-rc`) and a media/codec engine (`gt1-mc`).
//
// xe is the only driver here that answers "why": `freq0/throttle/` carries
// per-GT reason flags, which is what lets an xe GPU reach CONFIRMED.

import {assessGpu} from '../domain/gpu.js';
import {firstThermalReason} from './gpu-reasons.js';

const PCI_ROOT = '/sys/bus/pci/devices';
const DRIVER = 'xe';

/**
 * `gtidle/name` is the engine role, e.g. `gt0-rc` (render/compute) or
 * `gt1-mc` (media/codec).  Fall back to the directory name if it is absent.
 *
 * @param {string|null} roleName
 * @param {string} gt
 * @returns {string}
 */
function labelFor(roleName, gt) {
    if (roleName === null) return gt;
    if (roleName.includes('-mc')) return 'Media/Codec';
    if (roleName.includes('-rc')) return 'Render';
    return roleName;
}

/**
 * Runtime-PM states in which the device is not executing anything.  Read from
 * the PM core's own `power/runtime_status`, not from xe — see `read()`.
 */
const SUSPENDED = new Set(['suspended', 'suspending']);

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {{label: string, devicePath: string, freqDir: string,
 *            idlePath: string, throttleDir: string}[]}
 */
function findGts(sysfs) {
    const gts = [];
    for (const device of sysfs.list(PCI_ROOT)) {
        const devicePath = `${PCI_ROOT}/${device}`;
        if (sysfs.driverOf(devicePath) !== DRIVER) continue;

        for (const tile of sysfs.list(devicePath).filter(name => /^tile\d+$/.test(name))) {
            const tilePath = `${devicePath}/${tile}`;
            for (const gt of sysfs.list(tilePath).filter(name => /^gt\d+$/.test(name))) {
                const gtPath = `${tilePath}/${gt}`;
                const freqDir = `${gtPath}/freq0`;
                // Hold discovery to the same bar the rule applies: a ceiling
                // that is present but unreadable or zero would give a section
                // that says "no data" forever, while still counting as a GPU
                // found and so suppressing the "no supported GPU" warning.
                if (!(sysfs.readInt(`${freqDir}/rp0_freq`) > 0)) continue;
                gts.push({
                    label: labelFor(sysfs.readText(`${gtPath}/gtidle/name`), gt),
                    devicePath,
                    freqDir,
                    idlePath: `${gtPath}/gtidle/idle_status`,
                    throttleDir: `${freqDir}/throttle`,
                });
            }
        }
    }
    return gts;
}

/**
 * Read one GT without waking the GPU that owns it.
 *
 * Almost everything xe publishes about a GT's *current* state is behind
 * `guard(xe_pm_runtime)`, and that guard is not a "read it if it happens to be
 * awake": `xe_pm.h` defines it over `xe_pm_runtime_get()`, which ends in an
 * unconditional `pm_runtime_resume()`.  `act_freq`, `cur_freq`, `max_freq` and
 * `gtidle/idle_status` all carry it, so *any* of them resumes a suspended
 * device.  Only `rp0_freq` and `rpn_freq` are guard-free.
 *
 * Skipping the throttle registers on a parked GT therefore cannot save the
 * wake — by the time we know the GT is parked, we have already woken it, and
 * asking again a second later resets an autosuspend delay of 1000 ms.  (This
 * is where xe differs from i915, whose `act_freq_mhz` goes through
 * `with_intel_runtime_pm_if_in_use` and answers 0 without resuming.)
 *
 * So ask the PM core instead.  `power/runtime_status` is a device attribute of
 * the driver model, not of xe; `rpm_status_show()` formats a field and returns.
 * A suspended device is not executing anything and cannot be throttling, so its
 * whole reading is answered without touching one guarded attribute.
 *
 * The skip below the check is still worth keeping, but for the other reason:
 * once the device is awake, a parked GT's throttle registers cannot mean
 * anything, so there is no sense reading them.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {{devicePath: string, freqDir: string, idlePath: string, throttleDir: string}} gt
 * @returns {import('../domain/gpu.js').GpuReading}
 */
function read(sysfs, {devicePath, freqDir, idlePath, throttleDir}) {
    const frequency = name => sysfs.readInt(`${freqDir}/${name}_freq`);

    const runtimeStatus = sysfs.readText(`${devicePath}/power/runtime_status`);
    if (runtimeStatus !== null && SUSPENDED.has(runtimeStatus.toLowerCase()))
        return {
            currentMhz: 0,
            maxMhz: null,
            rp0Mhz: frequency('rp0'), // guard-free; safe on a suspended device
            idle: true,
            throttled: null,
            thermalReason: null,
            prochot: null,
        };

    // `idle_status` reports the GT's idle state: `xe_gt_idle.c` renders it
    // "gt-c0" or "gt-c6".  Any C6 state means the engine is parked; act_freq 0
    // says the same thing when the idle node is missing.
    const idleStatus = sysfs.readText(idlePath)?.toLowerCase() ?? null;
    const idle = frequency('act') === 0 || (idleStatus !== null && idleStatus.includes('c6'));

    const throttleAttribute = name =>
        idle ? null : sysfs.readInt(`${throttleDir}/${name}`);

    // `status` is the OR of every reason this platform publishes, taken from the
    // same register in the same read: `THROTTLE_ATTR_RO(status, U32_MAX)` masks
    // nothing, and `xe_gt_throttle_get_limit_reasons()` has already reduced the
    // register to the platform's mask.  So a status of 0 *is* every flag being
    // 0, and reading them would be seven more MMIO reads of a register that has
    // already answered — each one behind its own `guard(xe_pm_runtime)`.
    //
    // A limit asserting between the two reads shows status 0 and would show a
    // reason 1.  Skipping it loses nothing: the rule discards the reasons when
    // status is 0 anyway, and reports on the next poll.
    const status = throttleAttribute('status');
    const reason = name => status === 0 ? null : throttleAttribute(`reason_${name}`);

    return {
        currentMhz: frequency('cur'),
        maxMhz: frequency('max'),
        rp0Mhz: frequency('rp0'),
        idle,
        throttled: status,
        thermalReason: firstThermalReason(reason),
        prochot: reason('prochot'),
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'Intel Xe GPU',
    category: 'gpu',

    discover(sysfs) {
        return findGts(sysfs).map((gt, index) => ({
            id: `gpu:xe:${index}`,
            title: `GPU — ${gt.label}`,
            read: () => read(sysfs, gt),
            assess: assessGpu,
        }));
    },
};
