# Thermal Throttle Monitor

A GNOME Shell extension that shows CPU, iGPU, and NPU thermal throttle state as a
colour-coded indicator in the top bar — using the kernel's own hardware counters, not
just temperature. Ships with Intel support out of the box; extensible for any hardware.

---

## What it looks like

**Panel indicator** (three states):

```
● 72°C          ← green   — all nominal
● 89°C          ← orange  — approaching throttle threshold
⚠ 92°C 40%     ← red     — CPU thermally throttled 40% of the last 10 s
```

**Popup detail** (click to expand):

```
────── CPU ──────────────────────────────────────
████ CONFIRMED   CPU Package  92°C
  Throttled 40% of last poll — PROCHOT

────── iGPU — Render ────────────────────────────
░░░░ IDLE        iGPU Render  idle
  700 / 2000 MHz

────── iGPU — Media/Codec ───────────────────────
░░░░ IDLE        iGPU Media/Codec  idle
  500 / 1200 MHz

────── NPU ──────────────────────────────────────
█░░░ LOW         NPU  active
  950 / 1950 MHz (48%) — thermal unconfirmed
```

---

## Why it exists

Most thermal tools show you a temperature. This extension shows you whether the CPU
actually *throttled*. There is a difference: a CPU at 91 °C that isn't throttling is
fine; a CPU at 88 °C that is throttling is not.

The CPU signal (`core_throttle_total_time_ms`) is a kernel counter backed by a hardware
PROCHOT interrupt — it increments only when the chip itself reduces its clock to shed
heat. The panel turns red when that counter advances, and stays red for 30 seconds so
brief bursts don't vanish before you notice them.

---

## Confidence levels

The iGPU and NPU don't have the same definitive counter, so the extension is explicit
about certainty:

| Badge | Meaning |
|-------|---------|
| `████ CONFIRMED` | Kernel PROCHOT interrupt fired — definitively thermal |
| `███░ HIGH` | iGPU freq capped while CPU package is hot, or CPU at critical temp — thermal very likely |
| `██░░ MEDIUM` | Frequency cap applied or temperature near threshold |
| `█░░░ LOW` | Below maximum frequency; thermal cause unconfirmed |
| `░░░░ IDLE` | Component is inactive |
| `░░░░ —` | No sensor data found |

---

## Requirements

- GNOME Shell 45 or later
- No root access required — all sysfs paths are world-readable

**Included backends** (any combination works; missing hardware is silently skipped):

| Backend | Requirement |
|---------|-------------|
| Intel CPU | `thermal_throttle` sysfs entries — Haswell / 4th gen and later |
| Intel iGPU | `xe` driver (Arc / Xe) or `i915` driver (HD / Iris / UHD) |
| Intel NPU | Core Ultra (Meteor Lake and later), kernel 6.8+ |

Other hardware (AMD, NVIDIA, ARM…) is supported via custom backends — see [Adding hardware support](#adding-hardware-support).

---

## Installation

### From GNOME Extensions

Install from [extensions.gnome.org](https://extensions.gnome.org) or the GNOME
Extensions application.

### From source

```bash
git clone https://github.com/gheylen/gnome-thermal-monitor
cd gnome-thermal-monitor

# Compile the GSettings schema (required once, and after editing schemas/*.gschema.xml)
glib-compile-schemas schemas/

# Symlink into the extensions directory
UUID="thermal-throttle-monitor@glennheylen.com"
ln -sfn "$PWD" "$HOME/.local/share/gnome-shell/extensions/$UUID"

# Log out and back in (Wayland requires a full shell restart)
gnome-extensions enable "$UUID"
```

---

## Configuration

Open **GNOME Extensions** → ⚙ next to *Thermal Throttle Monitor*:

| Setting | Default | Effect |
|---------|---------|--------|
| Warning temperature | 88 °C | Panel turns orange above this package temperature |
| Critical temperature | 94 °C | Panel turns red; throttling imminent |
| Poll interval | 10 s | How often sensors and counters are read |

The colour thresholds apply when no confirmed throttle event has been observed. Once
the CPU throttle counter increments, the panel turns red regardless of these settings
and lingers for 30 seconds.

---

## Adding hardware support

The extension is built around a pluggable backend system. Adding support for AMD,
NVIDIA, ARM, or any other hardware is a single-file change.

### How it works

Every hardware type is a *backend* in `backends/`. Each backend discovers its hardware
once at startup and returns a list of *components*. The core polls each component on
every interval and handles the rest.

### Creating a backend

**1. Create `backends/your-backend.js`:**

```js
import {readFile, parseIntSafe} from '../lib/sysfs.js';
import {Confidence} from '../lib/confidence.js';

export default {
    name:     'My Hardware',   // shown in startup log
    category: 'mycat',         // hardware class string

    discover() {
        // Return [] if hardware is absent — never throw.
        const path = '/sys/...';
        if (readFile(path) === null) return [];

        return [{
            id:           'mycat',
            sectionTitle: 'My Hardware',

            readState() {
                return {freq: parseIntSafe(readFile(path))};
            },

            calcConf(state, prevState, context) {
                // context: { cpuTempC, pollMs, tempWarn, tempCrit }
                if (!state || state.freq === null)
                    return {level: Confidence.UNKNOWN, line1: 'My Hardware — no data', line2: ''};
                return {level: Confidence.LOW, line1: 'My Hardware', line2: `${state.freq} MHz`};
            },
        }];
    },
};
```

**2. Register it in `backends/index.js`:**

```js
import MyBackend from './your-backend.js';

export const BACKENDS = [
    IntelCpu, IntelXeGpu, IntelI915Gpu, IntelNpu,
    MyBackend,  // ← add here
];

export const CATEGORY_WARNINGS = {
    // ...existing entries...
    mycat: 'My hardware not found — check that the driver is loaded',
};
```

That's all the core needs. It discovers and polls your backend automatically.

### Sysfs paths for common hardware

| Hardware | Kernel module | Useful paths |
|----------|---------------|--------------|
| AMD CPU | `k10temp` | `/sys/bus/pci/devices/.../hwmon/hwmon*/temp*_input` |
| AMD GPU | `amdgpu` | `/sys/bus/pci/devices/.../hwmon/hwmon*/freq*_input` |
| Intel GPU (discrete) | `xe` | `/sys/bus/pci/devices/.../tile*/gt*/freq0/` |
| ARM SoC | `thermal_sys` | `/sys/class/thermal/thermal_zone*/temp` |

The full component interface (all fields, optional hooks, context spec) is documented
in `backends/index.js`.

---

## Diagnostics

If a component shows `░░░░ —` (no data), check the startup log:

```bash
journalctl -b /usr/bin/gnome-shell | grep ThermalThrottleMonitor
```

Common causes:

| Symptom | Fix |
|---------|-----|
| CPU shows no data | `modprobe coretemp` |
| iGPU shows no data | Check `lspci -k` — is `xe` or `i915` listed as the driver? |
| NPU shows no data | `modprobe intel_vpu` (requires kernel 6.8+) |

---

## Contributing

Bug reports and PRs are welcome.

When reporting an issue, include:
- GNOME Shell version: `gnome-shell --version`
- CPU model: `grep "model name" /proc/cpuinfo | head -1`
- Startup log: `journalctl -b /usr/bin/gnome-shell | grep ThermalThrottleMonitor`

---

## License

GPL-2.0-or-later
