# Contributing

Thanks for your interest in improving Thermal Throttle Monitor! Bug reports,
hardware backends, and documentation fixes are all welcome.

## Development setup

```bash
git clone https://github.com/gheylen/gnome-thermal-monitor
cd gnome-thermal-monitor
npm ci          # install dev dependencies (ESLint)
make install    # compile schema + symlink into the extensions dir
```

Then log out and back in (Wayland requires a full shell restart to load a new
extension), and enable it:

```bash
gnome-extensions enable thermal-throttle-monitor@glennheylen.com
```

## Before opening a pull request

Run the same checks CI runs:

```bash
make lint    # ESLint
make test    # unit tests (node --test)
make pack    # ensure the distributable still builds
```

All three must pass. Please keep changes focused and match the existing code
style (4-space indent, single quotes, aligned object literals — see
`.editorconfig` and `eslint.config.js`).

## Adding hardware support

The extension is built around a pluggable backend system: every hardware type
is a self-contained module in `backends/`, and the generic core
(`extension.js`) discovers and polls them at runtime. Adding support for new
hardware (AMD, NVIDIA, ARM, …) is normally a single new file plus one line in
`backends/index.js`.

The full backend and component interface — every field, optional hooks, and the
shared `context` object — is documented at the top of
[`backends/index.js`](backends/index.js). The README's
[Adding hardware support](README.md#adding-hardware-support) section has a
copy-paste skeleton and a `sysfs` cheat sheet for common hardware.

Two principles to preserve:

- **Never throw from `readState`/`discover`.** Use the helpers in
  `lib/sysfs.js`, which return `null`/`[]` on any error. A backend must not be
  able to crash the shell.
- **Be honest about confidence.** Only report `CONFIRMED` when a definitive
  hardware counter says so (e.g. a PROCHOT interrupt). Inference from frequency
  or temperature should cap at `HIGH`/`MEDIUM`/`LOW`.

New decision logic that is independent of the GJS runtime (like
`lib/gpu-common.js`) should come with unit tests under `test/`.

## Reporting bugs

Please use the issue templates. Include your GNOME Shell version, CPU model,
and the startup log — the bug-report template lists the exact commands.

## License

By contributing, you agree that your contributions are licensed under the
[GPL-2.0-or-later](LICENSE), the same license as the project.
