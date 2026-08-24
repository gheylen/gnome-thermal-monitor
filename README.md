# Thermal Throttle Monitor

[![CI](https://github.com/gheylen/gnome-thermal-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/gheylen/gnome-thermal-monitor/actions/workflows/ci.yml)
[![CodeQL](https://github.com/gheylen/gnome-thermal-monitor/actions/workflows/codeql.yml/badge.svg)](https://github.com/gheylen/gnome-thermal-monitor/actions/workflows/codeql.yml)
[![License: GPL v2](https://img.shields.io/badge/License-GPL_v2-blue.svg)](LICENSE)
![GNOME Shell 46–50](https://img.shields.io/badge/GNOME%20Shell-46–50-4A86CF?logo=gnome&logoColor=white)

A GNOME Shell extension that shows CPU, GPU, and NPU thermal throttle state as a
colour-coded indicator in the top bar — read from the kernel counters that record
throttling, not inferred from temperature. Intel CPU, GPU and NPU are supported; AMD
CPU and GPU ship as experimental backends, and adding one is a single adapter.

---

## What it looks like

<!-- A real screenshot is preferred over the mock below. Capture the panel
     indicator + open popup, save it to assets/screenshot.png, and uncomment:
![Thermal Throttle Monitor panel indicator and popup](assets/screenshot.png)
-->

**Panel indicator:**

```
● 72°C          ← panel colour  — all nominal
● 92°C          ← amber         — within 10 °C of this CPU's throttle point
⚠ 99°C         ← orange-red    — at the throttle point, or past your critical setting
⚠ 92°C (3)     ← red           — 3 physical cores thermally throttling
```

**Popup detail** (click to expand):

```
────── CPU ──────────────────────────────────────
████ CONFIRMED   92°C
  3 of 8 cores throttling — thermal (TCC)

────── GPU — Render ────────────────────────────
█░░░ LOW   Nominal
  1900 / 2050 MHz

────── GPU — Media/Codec ───────────────────────
░░░░ IDLE   Idle
  700 / 1200 MHz

────── NPU ──────────────────────────────────────
█░░░ LOW   Active
  950 / 1950 MHz (49%) — CPU 8°C from its throttle point
```

The indicator adopts the panel's own foreground colour when there is nothing to report,
so it blends with any GNOME Shell theme. Alert colours use the same values GNOME Shell
itself uses for error and warning states, and each confidence level has its own CSS
class in `stylesheet.css` (`.ttm-confirmed`, `.ttm-high`, `.ttm-medium`, `.ttm-low`,
`.ttm-idle`, `.ttm-unknown`) so a theme can override one without forking the extension.

---

## Why it exists

Most thermal tools show you a temperature. This extension shows you whether the CPU
actually *throttled*. There is a difference: a CPU at 91 °C that isn't throttling is
fine; a CPU at 88 °C that is throttling is not.

The CPU signal is `thermal_throttle/core_throttle_count`, a kernel counter incremented
by the thermal interrupt handler — it advances the moment the chip reduces its clock
to shed heat. The panel turns red when that happens, and stays red for 30 seconds so
brief bursts don't vanish before you notice them.

What sets that bit is worth being exact about, because the kernel's own name for it is
misleading. `therm_throt.c` feeds the counter from `THERM_STATUS_PROCHOT`, which
`msr-index.h` defines as bit 0 of `IA32_THERM_STATUS` — and in Intel's manual bit 0 is
**Thermal Status**: the core has reached its Thermal Control Circuit activation
temperature. The external PROCHOT# pin event is a different bit. That distinction is in
this extension's favour: an external PROCHOT# can be asserted by a voltage regulator or
a battery current limit and need not be thermal at all, whereas TCC activation is
nothing but thermal. So the popup says `thermal (TCC)`, not `PROCHOT`.

Its neighbour `core_throttle_total_time_ms` is read too, but it answers a different
question: the kernel advances it when an episode *ends*, so it says how much of the
interval was spent throttled rather than whether one is happening now. Reading it alone
— which this extension did until the rules were checked against `therm_throt.c` —
reports a throttle after it is over and reports nothing during a long one. It is an
accumulator, so a poll spanning a TCC that toggled many times reports their sum; the
popup says "N s throttled since the last poll" rather than claiming a single episode of
that length.

Beside those two the kernel publishes `package_throttle_count`, fed from the
package's own TCC activation, on every Intel part with a package thermal sensor.
It catches a package trip that no individual core's sensor reached — which would
otherwise be reported as a temperature and nothing more. It is read as a yes/no,
never a count: every logical CPU carries a copy of the one event, and on parts
with directed package interrupts only one copy is updated.

### The temperature, and why 88 °C means nothing on its own

When no counter has moved, the popup reports **headroom**: how many degrees are
left below the temperature at which this CPU throttles. That number comes from the
hardware — `coretemp` publishes TjMax as `tempN_crit`, and computes the temperature
itself as `tjmax - digital_readout`, so the difference recovers the processor's own
count of degrees remaining. On AMD, `k10temp` publishes the HTC trip point in the
same attribute where the part supports it.

The measurement is per sensor, not just per package. `coretemp` publishes a
temperature and a TjMax for every core beside the package pair, and the package
sensor is the package's own DTS rather than the maximum of the cores — so a
single core can sit well above it. Every channel is measured against its own trip
point and the tightest one is reported: `Core 2 at 93°C, 7°C below its throttle
point (100°C)`. The panel keeps showing the package temperature.

The headroom survives a TjMax the kernel had to guess at, too. Where the MSR is
unreadable `coretemp` falls back to a model table, but it subtracts the same value
to produce the temperature — so a wrong TjMax moves both numbers together and the
distance between them, which is what the verdict turns on, stays exact.

This matters because TjMax is not a constant. Across the parts `coretemp` knows
about it runs from 85 °C to 125 °C. A fixed warning at 88 °C is twelve degrees of
headroom on one laptop and two degrees *past* the trip point on another, where the
default critical of 94 °C can never be reached at all. Anything that colours a panel
from an absolute temperature alone is guessing.

The two settings remain, as what they always were — a preference. "Tell me at 88 °C"
is a reasonable thing to want. The rule evaluates both, takes the worse, and says
which one spoke:

```
  18°C below the throttle point (100°C)
  5°C below the throttle point (100°C) — above your critical threshold
  At the throttle point (100°C)
```

Neither ever reaches `CONFIRMED`. Only a counter does that.

To switch the preference off entirely, set it above your CPU's throttle point —
the popup tells you what that is. The range goes to 125 °C, the highest TjMax
`coretemp` knows about, so that is possible on any part.

The count is of *physical* cores wherever the kernel publishes CPU topology, which is
everywhere in practice. The counter itself is per logical CPU but the thermal event
belongs to the core, so on a machine with SMT both siblings advance together — counting
them would report twice the truth against twice the total. The grouping is the kernel's
own `topology/core_cpus_list`, not one reconstructed from package and core ids. On a
machine that exposes no topology the count falls back to logical CPUs, consistently on
both sides of the "N of M".

---

## Confidence levels

The GPU and NPU don't have the same definitive counter, so the extension is explicit
about certainty rather than rounding everything up to "hot".

| Badge | Meaning |
|-------|---------|
| `████ CONFIRMED` | A hardware counter says so — a CPU thermal (TCC) event, or a GPU PROCHOT reason flag |
| `███░ HIGH` | A GPU thermal reason flag — `thermal`, `ratl`, `vr_thermalert`, or one of the SoC/memory/VR limits — or the CPU at its own throttle point: strong evidence, short of proof |
| `██░░ MEDIUM` | Within 10 °C of the CPU's throttle point |
| `█░░░ LOW` | Running below maximum, or a GPU ceiling set by software; no thermal cause established |
| `░░░░ IDLE` | The component is inactive, so there is nothing to throttle |
| `░░░░ —` | No usable sensor data |

Inference never reaches `CONFIRMED`, and it does not look like it either: `HIGH` has its
own colour rather than sharing `CONFIRMED`'s red, so proof and strong-suspicion stay
distinguishable at a glance. The NPU publishes no throttle signal at all, so it is capped
at `LOW` whenever it is running — see [`BACKLOG.md`](BACKLOG.md).

---

## Requirements

- GNOME Shell 46 or later
- No root access required — every path read is world-readable `sysfs`
- No network access, no subprocesses, no file writes

**Included backends** (any combination works; missing hardware is skipped):

| Backend | Requirement |
|---------|-------------|
| Intel CPU | `thermal_throttle` sysfs entries (Haswell and later) and/or `coretemp` (which also supplies TjMax) |
| Intel GPU | `xe` driver (Arc / Xe) or `i915` driver (HD / Iris / UHD) |
| Intel NPU | Core Ultra (Meteor Lake and later), kernel 6.8+ (`intel_vpu`) |
| AMD CPU *(experimental)* | `k10temp` — temperature only; AMD exposes no confirmed-throttle counter, and this has not yet been validated on hardware |
| AMD GPU *(experimental)* | `amdgpu` — per-channel temperature against each channel's own `_crit`; the throttle status AMD does publish is inside a versioned binary struct, so this caps at `HIGH`. Not yet validated on hardware |

Other hardware is supported via additional backends — see
[Adding hardware support](#adding-hardware-support).

---

## Installation

### From GNOME Extensions

Not yet: this has not been published to
[extensions.gnome.org](https://extensions.gnome.org), and will not be until it
has been run on hardware that actually throttles — see
[`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md). Until then, build it from
source.

### From source

```bash
git clone https://github.com/gheylen/gnome-thermal-monitor
cd gnome-thermal-monitor

make install   # compile the schema and symlink into the extensions directory

# Log out and back in (Wayland requires a full shell restart)
gnome-extensions enable thermal-throttle-monitor@gheylen.github.io
```

`make uninstall` removes the symlink again.

### From a zip

`make pack` builds one under `dist/`, and a release publishes the same artifact.
Either way it carries the schema source rather than a compiled one, so unpacking
it into the extensions directory needs the schema compiled once:

```bash
unzip thermal-throttle-monitor@gheylen.github.io.shell-extension.zip \
  -d ~/.local/share/gnome-shell/extensions/thermal-throttle-monitor@gheylen.github.io
glib-compile-schemas \
  ~/.local/share/gnome-shell/extensions/thermal-throttle-monitor@gheylen.github.io/schemas/
```

The GNOME Extensions application compiles the schema for you; unpacking a zip by
hand does not.

---

## Configuration

Open **GNOME Extensions** → ⚙ next to *Thermal Throttle Monitor*:

| Setting | Default | Effect |
|---------|---------|--------|
| Warning temperature | 88 °C | Panel turns amber at or above this package temperature |
| Critical temperature | 94 °C | Panel turns orange-red at or above it — the red is kept for a throttle a counter confirmed |
| Poll interval | 10 s | How often sensors and counters are read (1–60 s) |
| Hide when nominal | off | Hide the indicator while nothing is throttling; it reappears on a warning or a confirmed throttle |
| Notify on throttling | off | Show a desktop notification when a confirmed throttle event begins |

The temperature thresholds apply when no confirmed throttle event has been observed.
Once a throttle counter advances the panel turns red regardless of them, and lingers
for 30 seconds. The notification fires once per burst, not once per poll, and it
stays in the message list until dismissed — a throttle that happened while you were
away is the one most worth knowing about.

---

## Repository map

```
extension.js  prefs.js      GNOME Shell adapters — St widgets, GLib timers, GSettings
src/presentation.js         badges, CSS classes, panel and popup wording
src/domain/                 the rules and the Monitor aggregate — pure, runtime-free
src/hardware/               one adapter per kernel driver, plus the registry
src/sysfs/                  the Sysfs port contract and its Gio implementation
schemas/                    GSettings schema
test/                       *.test.js under Node; *.gjs.js under gjs
tools/                      build-time checks: package completeness, Action pins,
                            the mutation suite
docs/ARCHITECTURE.md        the layering, and why it is shaped this way
```

The hardware code never touches `gi://` directly — it receives a Sysfs port, which is
what makes discovery and sysfs reading testable without the hardware. The layering is
enforced by ESLint, so a violation fails CI. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Adding hardware support

Supporting new silicon is a new file in `src/hardware/`, a rule in `src/domain/`, and
one line in the registry.

**1. Write the rule** — pure, no I/O, in `src/domain/mine.js`:

```js
import {Confidence} from './confidence.js';

export function assessMine(reading, previous, {packageTempC, thresholds}) {
    if (!reading || reading.freqMhz === null)
        return {level: Confidence.UNKNOWN, summary: 'No data', detail: ''};
    if (thresholds.isCritical(packageTempC))
        return {level: Confidence.MEDIUM, summary: 'Hot', detail: `${packageTempC}°C`};
    return {level: Confidence.LOW, summary: 'Nominal', detail: `${reading.freqMhz} MHz`};
}
```

**2. Write the adapter** — sysfs paths and nothing else, in `src/hardware/mine.js`:

```js
import {assessMine} from '../domain/mine.js';

export default {
    name: 'My Hardware',
    category: 'mycat',

    // Receives the Sysfs port. Never import `gi://` here — the linter will refuse it.
    discover(sysfs) {
        const path = '/sys/devices/.../freq';
        if (sysfs.readText(path) === null) return [];   // absent: return [], never throw

        return [{
            id: 'mycat:mine',                            // globally unique
            title: 'My Hardware',                        // popup section heading
            read: () => ({freqMhz: sysfs.readInt(path)}),
            assess: assessMine,
            // Optional: offer a CPU package temperature other rules can reason against.
            // temperatureC: reading => reading.tempC,
        }];
    },
};
```

**3. Register it** in `src/hardware/index.js`:

```js
import MyHardware from './mine.js';

export const DRIVERS = Object.freeze([/* … */, MyHardware]);

export const CATEGORY_WARNINGS = Object.freeze({
    // …
    // Omit the entry entirely for hardware that is genuinely optional, so its
    // absence is not reported to the user as a fault.
    mycat: 'My hardware not found — check that the driver is loaded',
});
```

**4. Test it.** No hardware needed — `test/helpers/fake-sysfs.js` takes a plain
`path → contents` map:

```js
const sysfs = fakeSysfs({files: {'/sys/devices/.../freq': '1400'}});
assert.equal(driver.discover(sysfs)[0].read().freqMhz, 1400);
```

The port exposes `readText`, `readInt`, `list` (naturally ordered) and `driverOf`. It
never throws and never returns `undefined`. `test/hardware/gpu-xe.test.js` is a good
model for a multi-device backend.

### Sysfs paths for common hardware

| Hardware | Kernel module | Useful paths |
|----------|---------------|--------------|
| AMD CPU | `k10temp` | `/sys/class/hwmon/hwmon*/temp*_input` |
| AMD GPU | `amdgpu` | `/sys/class/hwmon/hwmon*/` under the card's device |
| Intel GPU | `xe` | `/sys/bus/pci/devices/*/tile*/gt*/freq0/` |
| Intel GPU | `i915` | `/sys/class/drm/card*/gt/gt*/rps_*_freq_mhz` — the DRM node, not the PCI device |
| ARM SoC | `thermal_sys` | `/sys/class/thermal/thermal_zone*/temp` |

---

## Diagnostics

The quickest way to see what this extension makes of your machine, without
installing it:

```bash
gjs -m test/gjs/smoke.gjs.js
```

That runs the real hardware registry against your actual `/sys` and prints what
the panel would show — including which categories found nothing, and why. It
needs `gjs`, and nothing else.

If a component shows `░░░░ —` (no data), check the log:

```bash
journalctl -b /usr/bin/gnome-shell | grep ThermalThrottleMonitor
```

| Symptom | Fix |
|---------|-----|
| CPU shows no data | `modprobe coretemp` |
| GPU shows no data | Check `lspci -k` — is `xe`, `i915` or `amdgpu` listed as the driver? |
| NPU shows no data | `modprobe intel_vpu` (requires kernel 6.8+) |

One warning is logged per missing hardware *category*, once, at startup. A missing NPU
is not reported: it is optional hardware, not a fault.

---

## Development

```bash
npm ci           # dev dependencies (ESLint and its parser — the extension ships none)

make check       # everything CI runs: lint, test, test-gjs, pins, pack (covers schema)
make lint        # ESLint, including the architecture import rules
make test        # unit and integration tests under plain Node
make test-gjs    # the Gio sysfs adapter, under a real GJS runtime
make test-prefs  # prefs.js against real libadwaita widgets (needs GNOME + a display)
make pins        # every GitHub Action is SHA-pinned and labelled (offline)
make pack        # build dist/*.shell-extension.zip
make mutate      # break the code on purpose; every mutant must fail a test
make verify-pins # resolve every pinned Action SHA upstream (needs network)
make clean       # remove build artifacts
make help        # this list, printed from the Makefile itself
```

`make check` is the gate; CI runs it and then `make verify-pins`, which `check`
leaves out only because it needs the network. Requires Node 22+; `make test-gjs`
and `make pack` additionally need `gjs` and `glib-compile-schemas`.

`make mutate` is the one worth knowing about if you change a rule. It applies every
deliberate defect in `tools/mutants.json` — a counter read at the wrong edge, a widened
ratio, a dropped guard — and requires the suite to catch each one. A green test run says
the tests agree with the code; this says they would notice if the code were wrong.

Almost everything is testable without a GNOME session or the right silicon: the rules
and the wording run under plain Node, and the hardware adapters are driven by an
in-memory sysfs tree. The only module that needs a real runtime is `src/sysfs/gio.js`,
which has its own test under `gjs` — where the pure layers are also re-run, since
Node and the shell’s engine do not accept exactly the same JavaScript.

[`AGENTS.md`](AGENTS.md) is the short orientation for contributors and coding agents;
[`BACKLOG.md`](BACKLOG.md) records known gaps and deliberate non-goals.

### Reporting a bug

Include your GNOME Shell version (`gnome-shell --version`), CPU model
(`grep "model name" /proc/cpuinfo | head -1`), and the log line above.

### Releasing

Before any of this, run the pass in [`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md)
on a machine with the hardware. The gate proves the rules agree with the kernel source
and with described machines; it has never proved they agree with silicon that
throttles, and `extension.js` is only parse-checked.

`metadata.json`'s integer `version` is the single source of truth. Bump it, replace
that version's `— unreleased` heading in `CHANGELOG.md` with the release date, and push
a matching tag:

```bash
git tag v1 && git push origin v1
```

The release workflow refuses a tag that disagrees with `metadata.json`, and one whose
changelog heading is missing or still says "unreleased". Then it runs the full check and
publishes the zip. A published extensions.gnome.org version cannot be withdrawn, which
is why both are checked before anything is built.

---

## License

GPL-2.0-or-later
