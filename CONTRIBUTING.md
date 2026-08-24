# Contributing

Thanks for your interest in improving Thermal Throttle Monitor. Bug reports,
hardware backends, and documentation fixes are all welcome.

## Development setup

```bash
git clone https://github.com/gheylen/gnome-thermal-monitor
cd gnome-thermal-monitor
npm ci          # dev dependencies (ESLint and its parser)
make install    # compile the schema and symlink into the extensions directory
```

Then log out and back in — Wayland needs a full shell restart to load a new
extension — and enable it:

```bash
gnome-extensions enable thermal-throttle-monitor@gheylen.github.io
```

Requires Node 22 or later. `make test-gjs` and `make schema` additionally need
`gjs` and `glib-compile-schemas` (Debian/Ubuntu: `gjs libglib2.0-bin`).

`.claude/hooks/session-start.sh` installs all of that automatically in a Claude
Code on the web session, and does nothing on a local checkout.

## Before opening a pull request

```bash
make check
```

That is lint, the Node test suite, the GJS adapter test, the offline half of
the Actions pin check, schema validation and the distributable build. CI runs
it, and then `make verify-pins` — the other half of the pin check, which needs
network and so is not in the gate a contributor runs offline. All of it must
pass.

Match the existing style: four-space indent, single quotes, aligned object
literals. `.editorconfig` and `eslint.config.js` cover the mechanical parts.

If you change `prefs.js`, run `make test-prefs`. It imports the real module and
drives it through actual libadwaita widgets; on a GNOME desktop the dependencies
are already installed. CI runs it in a job of its own, so a break is caught
either way — but not by `make check`, which stays offline and desktop-free.

If you change a GitHub Actions pin, run `make verify-pins` yourself rather than
waiting for CI to say so. `make check` already refuses a `uses:` that is not a
40-character SHA with a version comment, which needs no network; `verify-pins`
goes further and resolves each SHA against its upstream repository, checking the
comment beside it names a tag that really points at that commit.

## How the code is arranged

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before making a structural
change. The short version: the rules (`src/domain/`) and the wording
(`src/presentation.js`) are pure and run under plain Node; the hardware adapters
(`src/hardware/`) receive a Sysfs port rather than reaching the kernel
themselves; only `src/sysfs/gio.js` touches `gi://`.

That layering is enforced by `no-restricted-imports` rules in
`eslint.config.js`, so a violation fails `make lint` rather than review.

## Adding hardware support

The README has a
[copy-paste skeleton](README.md#adding-hardware-support) and a sysfs cheat
sheet; the `Driver` and `Component` contracts are documented in
`src/domain/discovery.js` and `src/domain/monitor.js`.

Three principles to preserve:

- **Never throw from `discover()` or `read()`.** The Sysfs port returns `null`
  and `[]` on any failure; pass that through as missing data. This code runs
  inside the compositor, and an exception here is the user's whole desktop.
- **Be honest about confidence.** `CONFIRMED` means a hardware counter said so —
  the CPU's thermal (TCC) event counter, or a GPU's PROCHOT reason flag.
  Inference from frequency or temperature caps at `HIGH`, and hardware with no
  throttle signal at all caps lower still. Overstating certainty is the one bug
  this project cannot have, and that includes the words: the two counters above
  are named differently because they measure different things.
- **Give every component a globally unique id**, shaped
  `<category>:<driver>[:<index>]`. Discovery refuses duplicates.

## Tests

New logic needs tests, and writing them does not need the hardware:
`test/helpers/fake-sysfs.js` takes a plain `path → contents` map, so a machine
is a few lines of fixture. `test/hardware/gpu-xe.test.js` is a good model for a
multi-device backend, and `test/integration.test.js` drives a described laptop
through the real registry, Monitor and presentation — extend it when behaviour
changes shape.

Then break it on purpose. `make mutate` applies every defect in
`tools/mutants.json` and requires the suite to catch each one; add the mutant
that breaks your rule and watch it go red before trusting the test. A mutant
that survives is a gap, and one whose anchor no longer matches the source fails
the run too — a check that silently stopped checking is the failure mode this
project keeps finding in itself.

If you have the hardware, the most useful thing you can contribute is a run of
`gjs -m test/gjs/smoke.gjs.js`. It drives the real registry, the real Gio port
and your machine's actual `/sys` — no fake anywhere — and prints the verdicts the
panel would show. Nothing in this project has been observed on a machine that
throttles, and that output pasted into an issue is the shortest path from that
state to a fix.

Node cannot load `src/sysfs/gio.js`; its test lives in `test/gjs/` and runs
under `gjs`, alongside a test that walks the pure layers on that same engine —
Node accepting the syntax does not prove the shell will. Files there use the
`.gjs.js` suffix so the Node runner skips them.

## Reporting bugs

Please use the issue templates, and include your GNOME Shell version, CPU model,
and the startup log — the bug-report template lists the exact commands.

If you are reporting a wrong verdict, the popup detail line and the value of the
relevant sysfs file are what make it reproducible as a test.

## License

By contributing, you agree that your contributions are licensed under the
[GPL-2.0-or-later](LICENSE), the same license as the project.
