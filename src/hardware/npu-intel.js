// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Intel NPU adapter (intel_vpu) — Core Ultra / Meteor Lake and later.
//
// Identified by the `npu_*` attributes under /sys/class/accel/accel*/device/.
// Requires the intel_vpu module, mainline since kernel 6.8.
//
// `npu_max_frequency_mhz` and `npu_current_frequency_mhz` are the original
// spellings; current kernels keep them as aliases for `freq/hw_max_freq` and
// `freq/current_freq`, so reading the pair works on every kernel that has the
// driver at all.  Neither wakes the device: the max is a PLL ratio held in
// driver state, and `current_freq_show` takes `pm_runtime_get_if_active` and
// reports 0 rather than resuming — which is why the rule reads 0 as idle.
//
// `freq/set_max_freq` is the ceiling somebody configured, as opposed to the one
// the silicon has.  `ivpu_sysfs.c` adds it — and `set_min_freq` — to the `freq`
// group only for `ivpu_hw_ip_gen(vdev) >= IVPU_HW_IP_50XX`, so it is absent on
// Meteor Lake and Lunar Lake and reads null there.  `set_max_freq_show()` renders
// `pll.cfg_max_ratio` straight out of driver state, taking no lock and no runtime
// PM reference, and the store path clamps to the hardware limits — so it is both
// free to read and never above `hw_max_freq`.  Preferring it as the denominator
// is what stops a firmware-capped NPU reporting a percentage of a ceiling it has
// been told it may not reach.
//
// `npu_busy_time_us` is the one attribute with a cost.  It takes the driver's
// `submitted_jobs_lock`, and `ivpu_sysfs.c` says so in as many words: reading
// it "too often ... may have an impact on job submission performance", with a
// recommended period of 1 second.  That is the reason the poll interval's floor
// is 1 s and not lower; anything shorter would contend with job submission on a
// machine actually using its NPU.

import {assessNpu} from '../domain/npu.js';

const ACCEL_ROOT = '/sys/class/accel';
const CURRENT_FREQ = 'npu_current_frequency_mhz';

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {string|null} The accel device directory, or null if no NPU is present.
 */
function findDevice(sysfs) {
    for (const accel of sysfs.list(ACCEL_ROOT)) {
        const devicePath = `${ACCEL_ROOT}/${accel}/device`;
        if (sysfs.readText(`${devicePath}/${CURRENT_FREQ}`) !== null) return devicePath;
    }
    return null;
}

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string} devicePath
 * @returns {import('../domain/npu.js').NpuReading}
 */
function read(sysfs, devicePath) {
    const hardwareMaxMhz = sysfs.readInt(`${devicePath}/npu_max_frequency_mhz`);
    const configuredMaxMhz = sysfs.readInt(`${devicePath}/freq/set_max_freq`);

    return {
        currentMhz: sysfs.readInt(`${devicePath}/${CURRENT_FREQ}`),
        // The ceiling actually in force: the configured one where the generation
        // publishes it, the hardware one everywhere else.  `null > 0` is false,
        // so an absent or unreadable attribute falls through.
        maxMhz: configuredMaxMhz > 0 ? configuredMaxMhz : hardwareMaxMhz,
        hardwareMaxMhz,
        busyUs: sysfs.readInt(`${devicePath}/npu_busy_time_us`),
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'Intel NPU',
    category: 'npu',

    discover(sysfs) {
        const devicePath = findDevice(sysfs);
        if (devicePath === null) return [];

        return [{
            id: 'npu:intel',
            title: 'NPU',
            read: () => read(sysfs, devicePath),
            assess: assessNpu,
        }];
    },
};
