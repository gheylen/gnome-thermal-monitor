# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to integer extension versions as required by
extensions.gnome.org.

## [Unreleased]

## [4] — 2026-06-30

### Added
- GNOME Shell **50** support.
- `LICENSE` file (GPL-2.0-or-later) — the license was declared but not shipped.
- SPDX license headers on every source file.
- Unit tests (`node --test`) for the pure decision logic
  (`lib/confidence.js`, `lib/gpu-common.js`), wired into CI and releases.
- Community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, issue/PR templates.
- Supply-chain hardening: CodeQL code scanning, Dependabot, and
  SHA-pinned GitHub Actions.

### Changed
- Simplified the poll-interval handling in `extension.js` (no behaviour change).
- Clarified the CPU duty-cycle documentation (it is a saturating cross-core
  aggregate, not an exact wall-clock figure).

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
