# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to integer extension versions as required by
extensions.gnome.org.

## [1] — unreleased

First release. **Requires GNOME Shell 46 or later.**

### Added

- **A panel indicator that reports throttling rather than temperature.** Where a
  kernel counter records that the hardware reduced its own clock, the extension
  says so; where no counter exists, it says `UNKNOWN` rather than inferring one
  from heat. Four levels, and what each of them is allowed to mean:

  | Level | What it takes |
  | --- | --- |
  | `CONFIRMED` | a hardware counter said so — the CPU's per-core thermal (TCC) event counter, or a GPU driver's PROCHOT reason flag |
  | `HIGH` | a GPU reporting a thermal limit asserted, or a sensor sitting at its own trip point |
  | `MEDIUM` | within 10 °C of a trip point, which is the kernel's own definition of close, or past the temperature the platform says it aims to hold |
  | `LOW` | running below maximum, or held under a ceiling somebody set |

  A temperature never reaches `CONFIRMED`, and a software frequency cap — TLP on
  battery, gamemode — is reported as the power policy it is rather than as heat.

- **Headroom measured against each sensor's own trip point.** TjMax runs from
  85 °C to 125 °C across the parts `coretemp` knows about, so every reading is
  compared to the `tempN_crit` its own channel publishes — per core and per
  channel, never one sensor's reading against another's threshold.

- **Backends.** Intel CPU (`coretemp` and `thermal_throttle`), Intel GPU (`xe`
  and `i915`), Intel NPU (`intel_vpu`), and — experimental, never yet run on the
  silicon — AMD CPU (`k10temp`) and AMD GPU (`amdgpu`). Each is one adapter over
  one kernel driver; a machine with none of them says so instead of showing an
  empty panel.

- **A popup listing every component found**, with the reading behind each
  verdict: the throttling core count, the thermal limit a GPU actually named,
  the longest throttle episode since boot, and the frequency and headroom the
  level was drawn from.

- **Settings** (`hide-when-nominal`, `notify-on-throttle`, `poll-interval`,
  `temp-warn`, `temp-crit`), each range-validated in the schema so a value set
  directly through dconf cannot busy-loop the shell. The two temperatures are a
  preference layered over the hardware trip points, and the wording says which
  of the two raised a level.

- **Notifications on confirmed throttling**, off by default, edge-triggered so a
  long throttle notifies once, and sent from the extension's own source so they
  stay in the message list instead of vanishing with the banner.

### Notes on how this was built

None of the following changes what the panel says; it is why the above can be
trusted as far as it can.

- **A hexagonal architecture, enforced rather than intended.** The domain rules
  and the hardware adapters receive an injected `Sysfs` port and never import
  `gi://`, so every rule and every user-visible string runs under plain Node.
  ESLint enforces the layering and `test/architecture.test.js` lints deliberate
  violations, so the rules can still be shown to fail.

- **Nothing in the read path throws.** The port returns `null` or `[]`, adapters
  return readings full of `null`, rules answer `UNKNOWN`. An exception here
  would land in the compositor.

- **Every claim about hardware is sourced.** The rules were checked against
  mainline kernel source — `therm_throt.c`, `coretemp.c`, `k10temp.c`,
  `intel_rps.c`, `intel_gt_sysfs_pm.c`, `xe_gt_{freq,idle,throttle}.c`,
  `xe_pm.{c,h}`, `ivpu_sysfs.c`, `amdgpu_pm.c`, and the CPU topology ABI — and
  where a comment makes a claim, it cites the line that supports it. That
  includes the runtime-PM behaviour deciding which attributes may be read
  without waking a suspended GPU.

- **Test quality is checked rather than assumed.** `make mutate` applies 173
  deliberate defects and requires the suite to catch each one; a mutant whose
  anchor no longer matches the source fails the run too, because a check that
  quietly stopped checking is worse than a gap. The suite also holds the
  repository to itself — that the prose names real `make` targets and real
  files, that every shipped module is exercised, that nothing is exported
  without a caller, and that every file keeps to `.editorconfig`.

- **No root, no subprocesses, no network requests**, and no writes beyond the
  extension's own GSettings keys.

### Known limitations

- **This has never run on hardware that was actually throttling.** Every verdict
  is checked against kernel source and against machines the test suite
  describes; none of it has been observed on silicon reducing its own clock.
  [`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md) is the pass to make before
  tagging, and `BACKLOG.md` records this as the standing risk it is.
- **The AMD backends are experimental.** `k10temp` publishes no confirmed-throttle
  counter, so the AMD CPU path caps at `HIGH`; neither AMD backend has been run
  on the silicon.
- `extension.js` and `prefs.js` are parse-checked rather than loaded, because
  GNOME Shell's own `js/ui` modules are not resolvable outside the compositor.
  `prefs.js` is additionally driven through real libadwaita widgets by
  `make test-prefs`.
