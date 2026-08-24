// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The three things every hwmon-backed adapter needs, in one place.
//
// Both CPU adapters walk /sys/class/hwmon looking for a device by its `name`,
// pair a `tempN_label` with the `tempN_*` attributes beside it, and convert
// millidegrees to something a person reads. Written twice, those drift — and one
// of them drifting is how a temperature comes to be rounded in one adapter and
// truncated in the other, which is a degree of error nobody would ever trace.
//
// Deliberately three small functions and not a framework: which label a backend
// wants, and what it does when there is none, are its own business. This module
// knows the layout `Documentation/hwmon/sysfs-interface` describes and nothing
// about any particular chip.

const HWMON_ROOT = '/sys/class/hwmon';

/**
 * Every hwmon device reporting the given driver name, in natural order.
 *
 * A name is not unique: a machine can carry two of the same chip, and the
 * numbering of `hwmonN` is allocation order rather than anything stable. Callers
 * take the first that satisfies them rather than assuming there is one.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string} name  The driver's `name` attribute, e.g. 'coretemp'.
 * @returns {string[]} Device directory paths.
 */
export function devicesNamed(sysfs, name) {
    return sysfs.list(HWMON_ROOT)
        .map(entry => `${HWMON_ROOT}/${entry}`)
        .filter(device => sysfs.readText(`${device}/name`) === name);
}

/**
 * The labelled *temperature* channels of one device, in natural order.
 *
 * A channel is the prefix the attributes share — `…/hwmon2/temp1` — because the
 * useful ones come in sets: `_input` is the reading and `_crit` is the trip
 * point it means anything against. Returning one attribute would make pairing
 * them the caller's problem, and pairing them across devices is a bug.
 *
 * Restricted to `tempN` on purpose. `Documentation/hwmon/sysfs-interface` gives
 * every sensor kind the same `_label` suffix, and `amdgpu` publishes a
 * `freq1_label` reading "sclk" — which an earlier version of this returned as a
 * temperature channel with a perfectly readable `freq1_input` behind it. Both
 * CPU drivers happen to label temperatures and nothing else, so the mistake was
 * invisible until a third caller arrived.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string} device
 * @returns {{label: string|null, channel: string}[]}
 */
export function temperatureChannels(sysfs, device) {
    return sysfs.list(device)
        .filter(file => /^temp\d+_label$/.test(file))
        .map(file => ({
            label: sysfs.readText(`${device}/${file}`),
            channel: `${device}/${file.slice(0, -'_label'.length)}`,
        }));
}

/**
 * A hwmon temperature attribute, in whole degrees Celsius.
 *
 * hwmon reports millidegrees. Rounded rather than truncated: 94 999 is 95 °C,
 * and reporting it as 94 would put a machine a degree further from its trip
 * point than it is.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string|null} path
 * @returns {number|null}
 */
export function degreesAt(sysfs, path) {
    const millidegrees = path !== null ? sysfs.readInt(path) : null;
    return millidegrees !== null ? Math.round(millidegrees / 1000) : null;
}
