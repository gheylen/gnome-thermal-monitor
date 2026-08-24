// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Which of a GPU's throttle-reason flags mean heat, and what to call them.
//
// Both Intel drivers publish the same set of per-reason booleans, differing only
// in the prefix: `throttle_reason_thermal` on i915 (`intel_gt_sysfs_pm.c`),
// `reason_thermal` on xe (`xe_gt_throttle.c`). Deciding which of them is thermal
// is hardware knowledge, so it lives here rather than in `src/domain/gpu.js` —
// the rule asks "was a thermal limit asserted, and which", and does not learn
// the name of a single Intel register.
//
// The set is platform-dependent, which is the reason this is a list and not two
// fields. `xe_gt_throttle.c` gives Crescent Island `reason_ratl` but *no*
// `reason_thermal` at all, replacing it with `reason_soc_thermal`,
// `reason_soc_avg_thermal`, `reason_mem_thermal` and `reason_vr_thermal`; it
// also drops `reason_vr_thermalert`, which every other platform has. Reading all
// of them and taking the first that is set covers every platform either driver
// supports; the ones a given machine does not publish read as `null` and cost
// one failed open each, which is cheaper than teaching discovery the table.
//
// `vr_tdc`, `pl1`, `pl2`, `pl4`, `psys_*` and `iccmax` are deliberately absent:
// those are current and power limits, and this project does not present a power
// limit as heat.
//
// Every flag is its own read, and on xe each one is its own MMIO read of the
// same PERF_LIMIT_REASONS register (`reason_show()` calls
// `xe_gt_throttle_get_limit_reasons()` per attribute), so the set is not a
// coherent snapshot: a limit that clears mid-poll can be reported one poll late,
// or missed. It changes no verdict — every thermal reason lands on the same
// level — only which of two simultaneous limits gets named. xe's `reasons`
// attribute would give one coherent read, but i915 publishes no such node, so
// per-flag reads are the only shape both drivers support.

/**
 * Thermal limits, most specific first. The attribute name is the suffix both
 * drivers share; the label is what the popup says.
 *
 * @type {readonly {attribute: string, label: string}[]}
 */
export const THERMAL_REASONS = Object.freeze([
    {attribute: 'thermal', label: 'thermal'},
    // Running Average Thermal Limit: a sustained thermal budget rather than an
    // instantaneous trip. Present on Crescent Island, where `thermal` is not.
    {attribute: 'ratl', label: 'thermal (running average limit)'},
    {attribute: 'vr_thermalert', label: 'voltage regulator thermal alert'},
    // Crescent Island's set. Absent — and so null — on every consumer part.
    {attribute: 'soc_thermal', label: 'SoC thermal'},
    {attribute: 'soc_avg_thermal', label: 'SoC thermal (average)'},
    {attribute: 'mem_thermal', label: 'memory thermal'},
    {attribute: 'vr_thermal', label: 'voltage regulator thermal'},
]);

/**
 * The first thermal limit this GT reports as asserted.
 *
 * @param {(attribute: string) => number|null} read
 *   Reads one reason attribute by its shared suffix, returning `null` where the
 *   platform does not publish it.
 * @returns {string|null} The label to report, or null if none is asserted.
 */
export function firstThermalReason(read) {
    for (const {attribute, label} of THERMAL_REASONS)
        if (read(attribute) === 1) return label;
    return null;
}
