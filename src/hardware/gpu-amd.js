// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// AMD GPU adapter (amdgpu) — EXPERIMENTAL, not yet validated on hardware.
//
// `amdgpu_pm.c` registers one hwmon device per card, named after the driver, and
// documents its temperature interface in as many words:
//
//   temp[1-3]_input      on-die temperature, millidegrees
//   temp[1-3]_label      "edge", "junction", "mem" — `temp_label[]` in that file
//   temp[1-3]_crit       "temperature critical max value"
//   temp[1-3]_emergency  "temperature emergency max value (asic shutdown)"
//   freq1_input          the gfx/compute clock, in hertz
//
// Only channel 1 exists on pre-SOC15 parts; junction and memory arrive with the
// SOC15 dGPUs.  Each channel carries its own `_crit`, so this adapter hands the
// rule a sensor per channel and lets it measure each against its own trip point,
// exactly as the Intel CPU adapter does with `coretemp`'s cores.
//
// `_emergency` is deliberately not read.  It is the temperature at which the
// ASIC shuts itself down, which is a different event from throttling and would
// be a second trip point in a popup that has room for one.
//
// What is missing, and why this backend cannot reach CONFIRMED: amdgpu publishes
// no per-reason throttle flags as text.  Its throttle status is a field inside
// `gpu_metrics`, a versioned binary struct whose layout moves with the firmware.
// See `src/domain/gpu-temperature.js`.

import {assessGpuTemperature} from '../domain/gpu-temperature.js';
import {degreesAt, devicesNamed, temperatureChannels} from './hwmon.js';

const DRIVER = 'amdgpu';

/** Hertz, as `amdgpu_hwmon_show_sclk` emits it (`sclk * 10 * 1000`). */
const HZ_PER_MHZ = 1_000_000;

/**
 * The channels this card actually has a sensor behind.
 *
 * `amdgpu_hwmon_is_visible()` hides the junction and memory attributes on parts
 * without those sensors, and a label with nothing behind it would become a
 * section reporting "no data" for ever.
 *
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {string} device
 * @returns {{label: string|null, channel: string}[]}
 */
const readableChannels = (sysfs, device) =>
    temperatureChannels(sysfs, device)
        .filter(({channel}) => sysfs.readText(`${channel}_input`) !== null);

/**
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {{device: string, channels: {label: string|null, channel: string}[]}} card
 * @returns {import('../domain/gpu-temperature.js').GpuTemperatureReading}
 */
function read(sysfs, {device, channels}) {
    const hertz = sysfs.readInt(`${device}/freq1_input`);

    return {
        sensors: channels.map(({label, channel}) => ({
            label,
            tempC: degreesAt(sysfs, `${channel}_input`),
            throttlePointC: degreesAt(sysfs, `${channel}_crit`),
            targetC: null, // amdgpu publishes no equivalent of ttarget.
        })),
        // Rounded rather than truncated, for the reason `degreesAt` is: a clock
        // reported one unit low is a clock that never quite reaches its own
        // maximum. `null > 0` is false, so an absent attribute stays absent.
        currentMhz: hertz > 0 ? Math.round(hertz / HZ_PER_MHZ) : null,
    };
}

/** @type {import('../domain/discovery.js').Driver} */
export default {
    name: 'AMD GPU',
    category: 'gpu',

    discover(sysfs) {
        const cards = [];
        for (const device of devicesNamed(sysfs, DRIVER)) {
            const channels = readableChannels(sysfs, device);
            if (channels.length > 0) cards.push({device, channels});
        }

        return cards.map((card, index) => ({
            id: `gpu:amdgpu:${index}`,
            title: cards.length > 1 ? `GPU — AMD ${index}` : 'GPU — AMD',
            read: () => read(sysfs, card),
            assess: assessGpuTemperature,
        }));
    },
};
