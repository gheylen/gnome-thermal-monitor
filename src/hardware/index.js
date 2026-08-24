// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Hardware registry — the only file to edit when adding support for new silicon.
//
// To add a backend:
//   1. Write src/hardware/<your-driver>.js against the Driver contract in
//      src/domain/discovery.js.  It receives a Sysfs port; it must not import
//      `gi://` or reach the filesystem any other way.
//   2. Import it here and append it to DRIVERS.
//   3. If it introduces a new hardware category, add a CATEGORY_WARNINGS entry.
//   4. Add tests under test/hardware/ driven by test/helpers/fake-sysfs.js.
//
// See docs/ARCHITECTURE.md for the layering rules the contract enforces.

import IntelCpu from './cpu-intel.js';
import AmdCpu from './cpu-amd.js';
import IntelXeGpu from './gpu-xe.js';
import IntelI915Gpu from './gpu-i915.js';
import AmdGpu from './gpu-amd.js';
import IntelNpu from './npu-intel.js';

/**
 * Tried in order.  Several drivers in one category may coexist — a machine with
 * both an xe and an i915 device shows both.  The CPU drivers are mutually
 * exclusive in practice: each matches only its own vendor's hwmon `name`.
 *
 * @type {readonly import('../domain/discovery.js').Driver[]}
 */
export const DRIVERS = Object.freeze([
    IntelCpu,
    AmdCpu,
    IntelXeGpu,
    IntelI915Gpu,
    AmdGpu,
    IntelNpu,
]);

/**
 * Logged once at startup for each category where no driver found hardware.
 * A category with no entry here is optional and stays silent — the NPU is
 * absent from most machines and should not look like a fault.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const CATEGORY_WARNINGS = Object.freeze({
    cpu: 'CPU thermal data unavailable — check that coretemp (Intel) or k10temp (AMD) is loaded',
    gpu: 'No supported GPU found — needs the xe, i915 or amdgpu driver',
});
