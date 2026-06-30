# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to integer extension versions as required by
extensions.gnome.org.

## [Unreleased]

## [4] — 2026-06-30

### Added
- GNOME Shell **50** support.
- **AMD CPU backend** (experimental, `k10temp`) — temperature only; AMD exposes
  no confirmed-throttle counter, so it caps at HIGH. Not yet validated on
  hardware.
- **Hide-when-nominal** setting — hide the indicator while nothing is throttling.
- **Notify-on-throttle** setting — desktop notification on a confirmed throttle
  event (edge-triggered, so it fires once per burst). Both settings default off.
- `LICENSE` file (GPL-2.0-or-later) — the license was declared but not shipped.
- SPDX license headers on every source file.
- Unit tests (`node --test`) for all pure decision logic — CPU, xe/i915 iGPU,
  NPU confidence modules, the freq-cap helper, and the panel-policy helpers —
  wired into CI and releases.
- Community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue/PR templates.
- Supply-chain hardening: CodeQL code scanning, Dependabot, and
  SHA-pinned GitHub Actions.
- Schema-level `<range>` validation on all settings keys, so an out-of-bounds
  value set directly via dconf (e.g. `poll-interval` 0) can't busy-loop the shell.

### Changed
- **CPU throttle display now shows how many cores are throttling** (`(3)` in the
  panel, "3 of 16 cores throttling" in the popup) instead of a cross-core
  percentage that could saturate to a misleading 100%.
- Refactored each backend's confidence logic into pure, runtime-independent
  `lib/conf-*.js` modules so it can be unit-tested without the GJS runtime.
  No behaviour change to the Intel backends.
- Simplified the poll-interval handling in `extension.js` (no behaviour change).

## [3] — 2026-04-09

### Added
- GPU common module shared between the xe and i915 backends.
- Stylesheet for per-confidence panel colours.
- Release CI workflow.

### Changed
- Hardened the audit surface; de-duplicated xe/i915 logic.

## [2] — 2026-04-09

### Added
- GitHub repository URL in metadata and installation instructions.

## [1] — 2026-04-08

### Added
- Initial release: colour-coded CPU / iGPU / NPU thermal throttle indicator
  with Intel CPU, xe/i915 iGPU, and NPU backends.

[Unreleased]: https://github.com/gheylen/gnome-thermal-monitor/compare/v4...HEAD
[4]: https://github.com/gheylen/gnome-thermal-monitor/compare/v3...v4
[3]: https://github.com/gheylen/gnome-thermal-monitor/compare/v2...v3
[2]: https://github.com/gheylen/gnome-thermal-monitor/compare/v1...v2
[1]: https://github.com/gheylen/gnome-thermal-monitor/releases/tag/v1
