// Backend registry — the only file to touch when adding hardware support.
//
// ─── Adding a new backend ────────────────────────────────────────────────────
//
// 1. Create backends/your-backend.js following the interface below.
// 2. Import it here and add it to BACKENDS.
// 3. If it introduces a new hardware category, add a CATEGORY_WARNINGS entry.
//
// ─── Backend interface ───────────────────────────────────────────────────────
//
//   export default {
//     name:     string,        // human-readable, used in log messages
//     category: string,        // hardware class: 'cpu' | 'igpu' | 'npu' | …
//     discover(): Component[], // called once at enable(); return [] if absent
//   }
//
// ─── Component interface (objects returned by discover()) ────────────────────
//
//   {
//     id:           string,   unique menu-section key
//     sectionTitle: string,   popup menu separator label
//
//     readState(): State,
//       Poll sysfs.  Return a plain object; null values are allowed.
//       Never throw — use null / 0 as sentinel for missing data.
//
//     calcConf(state, prevState, context): Conf,
//       Compute confidence.  prevState is the previous poll's readState()
//       result (null on the very first poll — handle gracefully).
//       Returns: { level, line1, line2, panelSuffix? }
//         level:       Confidence constant from lib/confidence.js
//         line1:       first popup line  (badge row)
//         line2:       second popup line (detail row; '' to hide)
//         panelSuffix: optional string appended to the top-bar label
//                      (e.g. ' 40%' for CPU throttle duty-cycle)
//
//     contributeContext?(state, context): void,   [optional]
//       Called in pass 1 (before any calcConf).  Populate shared fields on
//       context so later components can use them.  Currently used by the CPU
//       backend to set context.cpuTempC.
//   }
//
// ─── Context object passed to calcConf and contributeContext ─────────────────
//
//   {
//     cpuTempC: number | null,   CPU package temp (set by cpu backend)
//     pollMs:   number,          poll interval in milliseconds
//     tempWarn: number,          warning threshold in °C  (from GSettings)
//     tempCrit: number,          critical threshold in °C (from GSettings)
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

import IntelCpu    from './cpu-intel.js';
import IntelXeGpu  from './gpu-xe.js';
import IntelI915Gpu from './gpu-i915.js';
import IntelNpu    from './npu-intel.js';

// Backends are tried in order.  Multiple backends in the same category can
// coexist — e.g. a system with both an xe dGPU and an i915 iGPU shows both.
export const BACKENDS = [
    IntelCpu,
    IntelXeGpu,
    IntelI915Gpu,
    IntelNpu,
];

// One warning fires per category when no backend in that category finds hardware.
// Add an entry here when introducing a new hardware category.
export const CATEGORY_WARNINGS = {
    cpu:  'CPU thermal data unavailable — check that coretemp is loaded ' +
          'and /sys/devices/system/cpu/cpu0/thermal_throttle/ exists',
    igpu: 'No supported iGPU found (xe or i915 driver required)',
    // npu is intentionally absent: it is optional Intel-specific hardware;
    // non-Intel systems should not see a warning for a missing NPU.
};
