// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// AMD CPU adapter (k10temp) — EXPERIMENTAL, not yet validated on hardware.
//
// AMD publishes no per-core throttle counter, so this adapter is temperature
// only.  It reports an empty core array, which routes the shared CPU rule
// straight to the temperature tier and makes CONFIRMED structurally
// unreachable — the honest ceiling for hardware that cannot prove a throttle.
//
// Sensor preference: Tctl (the control temperature the platform throttles
// against) → Tdie (actual die temperature) → the first readable input.
//
// The channel's `_crit`, where the driver publishes one, is the HTC trip
// temperature — AMD's hardware thermal control, the equivalent of Intel's TCC.
// `k10temp.c` decodes it from the HTC register and hides the attribute unless
// the northbridge advertises HTC and it is enabled.  In practice that means
// pre-Zen: `read_htcreg` is only assigned in the non-Zen branches of
// `k10temp_probe()`, and `k10temp_is_visible()` hides `_crit` without it.  On
// Zen there is no throttle point to read and the rule falls back to the user's
// thresholds alone.  Note it is `_crit` and not `_max`: k10temp hard-codes
// `_max` to 70 °C, which is a target, not a trip point.
//
// The two halves of that are exactly inverted, which is why the unlabelled
// fallback below is not an edge case.  `k10temp_is_visible()` shows
// `tempN_label` "only on Zen CPUs", so the parts that publish a trip point are
// precisely the parts that publish no labels, and the parts with labels have no
// trip point.
//
// Nor are the per-die channels worth reading, though the Intel adapter reads
// its per-core ones.  `k10temp_info[]` gives channel 0 INPUT | MAX | CRIT |
// CRIT_HYST | LABEL and every `Tccd*` channel INPUT | LABEL alone, and
// `k10temp_is_visible()` returns 0 for `_crit` on any non-zero channel
// (`if (channel || !data->read_htcreg) return 0;`).  A per-die temperature with
// no trip point beside it is a number this project has nothing to say about.

import {assessCpu} from '../domain/cpu.js';
import {degreesAt, devicesNamed, temperatureChannels} from './hwmon.js';

const PREFERRED_LABELS = ['Tctl', 'Tdie'];

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @returns {string|null} Channel prefix, e.g. `/sys/class/hwmon/hwmon3/temp1`.
 */
function findSensor(sysfs) {
    for (const device of devicesNamed(sysfs, 'k10temp')) {
        const byLabel = new Map();
        let firstChannel = null;
        for (const {label, channel} of temperatureChannels(sysfs, device)) {
            if (sysfs.readText(`${channel}_input`) === null) continue;
            firstChannel ??= channel;
            // First wins: sysfs listings are naturally ordered, and letting a
            // later duplicate overwrite would make which sensor is read depend
            // on directory order.
            if (label !== null && !byLabel.has(label)) byLabel.set(label, channel);
        }

        // Some k10temp versions ship no labels at all.
        if (firstChannel === null && sysfs.readText(`${device}/temp1_input`) !== null)
            firstChannel = `${device}/temp1`;

        const preferred = PREFERRED_LABELS.map(label => byLabel.get(label)).find(Boolean);
        const channel = preferred ?? firstChannel;
        if (channel) return channel;
    }
    return null;
}

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string} channel
 * @returns {import('../domain/cpu.js').CpuReading}
 */
function read(sysfs, channel) {
    return {
        cores: [],           // No per-core counter exists; see the module comment.
        packageEpisodes: [], // Nor a package one: k10temp publishes no counters.
        packageTempC: degreesAt(sysfs, `${channel}_input`),
        throttlePointC: degreesAt(sysfs, `${channel}_crit`),
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'AMD CPU',
    category: 'cpu',

    discover(sysfs) {
        const channel = findSensor(sysfs);
        if (channel === null) return [];

        return [{
            id: 'cpu:amd',
            title: 'CPU',
            read: () => read(sysfs, channel),
            assess: assessCpu,
            temperatureC: reading => reading?.packageTempC ?? null,
            // Offered beside the temperature so the rules can measure headroom
            // rather than compare against an absolute number that means
            // something different on every part.
            throttlePointC: reading => reading?.throttlePointC ?? null,
        }];
    },
};
