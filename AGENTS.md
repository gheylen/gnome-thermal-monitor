# Working in this repository

A GNOME Shell extension that reports CPU / GPU / NPU thermal throttle state,
read from kernel hardware counters rather than inferred from temperature.

## Orientation

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it is short, and the
layering it describes is enforced by the linter, so working against it will fail
CI. [`BACKLOG.md`](BACKLOG.md) files everything review has turned up under three
headings — what the kernel passes left open, what is worth doing, and what was
decided against. Check which heading an idea is already under before starting it.

```
extension.js  prefs.js      GNOME Shell adapters (St, GLib, GSettings)
src/presentation.js         glyphs, CSS classes, wording — pure
src/domain/                 rules and the Monitor aggregate — pure
src/hardware/               one adapter per kernel driver
src/sysfs/                  the Sysfs port and its Gio implementation
test/                       *.test.js run under Node; *.gjs.js run under gjs
tools/                      build-time checks and the mutation suite; never shipped
```

## Commands

```bash
npm ci            # dev dependencies (ESLint and its parser; nothing ships)
make check        # everything CI runs: lint, test, test-gjs, pins, schema, pack
make test         # Node tests only — fast, no GJS needed
make test-gjs     # the Gio sysfs adapter, under a real GJS runtime
make test-prefs   # prefs.js against real libadwaita (needs GNOME + a display)
make install      # symlink into ~/.local/share/gnome-shell/extensions
make mutate       # break the code on purpose; every mutant must fail a test
make verify-pins  # resolve every pinned Action SHA upstream (needs network)
make help         # list the targets, from the Makefile's own comments
```

`make check` is the gate. Run it before proposing a change: CI runs it, and then
`make verify-pins`, which is the one thing `check` leaves out because it needs
the network.

In a Claude Code on the web session, `.claude/hooks/session-start.sh` has already
installed the npm dev dependencies and the two system packages the gate needs
(`gjs`, `libglib2.0-bin`), so `make check` works from the first command. It is a
no-op on a local checkout — installing system packages there is the developer's
own business.

## How this repository has been wrong before

Every audit so far has found the same shape, in a different place. It is worth
knowing before you start, because it is not the shape code review is good at
catching — everything is internally consistent right up until it meets a kernel.

- **A fixture written from the implementation.** The i915 adapter looked under
  the PCI device, where i915 publishes nothing, and eight tests passed because
  their fixtures described the same wrong machine. Later, a test asserted that
  skipping xe's throttle registers avoided a wake — in a fake sysfs that has no
  runtime PM, so it could not have failed. **Check the driver source, not the
  fixture.** A test suite proves consistency; only the kernel proves correctness.
  The fake itself is now held to the shipped adapter's behaviour by a shared
  contract (`test/helpers/port-contract.js`), run against both — because the
  same mistake one layer down would invalidate every hardware test at once.
- **A check that matches nothing.** `resource://*` never matched, because `*`
  does not cross a `/`, so a layering rule lint-passed for months while
  enforcing nothing. The mutation runner's first draft reported every mutant
  killed because the tests never ran in its workspace. **A guard needs a test
  that makes it fire**, which is why `test/architecture.test.js` lints
  deliberate violations and `make mutate` fails on a stale anchor.
- **Prose asserting more than the code knows.** The CPU detail line said
  "throttle imminent" at a number the user had typed; the changelog claimed an
  xe power fix that could not work. **If a sentence makes a claim about
  hardware, find the line of kernel source that supports it** — and cite it in
  the comment, as the rules here now do.

## Rules that are not negotiable

- **Nothing in the read path may throw.** The Sysfs port returns `null` / `[]`,
  adapters return readings full of `null`, rules answer `UNKNOWN`. An exception
  here lands in the compositor.
- **`CONFIRMED` means a hardware counter said so.** Never raise a verdict's
  level on inference. Frequency shape and temperature cap at `HIGH`.
- **A temperature is meaningless without its trip point.** TjMax runs from 85 °C
  to 125 °C across the parts `coretemp` knows about, so the CPU rule measures
  headroom below `tempN_crit` rather than against an absolute number — on every
  channel the driver publishes, each against its own `_crit`, never one sensor's
  reading against another's trip point. The two user settings are a preference
  layered on top; the wording says which of the two raised a level.
- **The domain and the hardware adapters must not import `gi://`.** They receive
  a Sysfs port. `eslint.config.js` enforces this.
- **Only `src/log.js` may call `console`.** Also enforced.
- **Shipped code targets SpiderMonkey 115**, which is what GNOME Shell 46 —
  `metadata.json`'s floor — ships (GJS 1.80; SpiderMonkey 128 arrived in 1.81.2,
  in the 47 cycle). Node 22 and a developer's `gjs` are both
  ahead of it, so a newer built-in works everywhere here and fails on the oldest
  shell this extension claims. `eslint.config.js` refuses the tempting ones by
  name and the parser refuses newer syntax; tests are exempt, since they never
  run in the shell.
- **Component ids are globally unique** (`<category>:<driver>[:<index>]`).
  Discovery refuses duplicates.
- **Never invent a GitHub Actions SHA.** Every `uses:` is pinned to a commit,
  and this is a public repository — a wrong pin breaks CI for everyone who opens
  a pull request. `make check` refuses an unpinned or unlabelled `uses:` offline;
  proving the SHA is the *right* one needs the network, so resolve it
  (`git ls-remote https://github.com/OWNER/REPO refs/tags/vX.Y.Z^{}`) and run
  `make verify-pins`.
- **Never name a method `_onDestroy` in `extension.js`.** `PanelMenu.ButtonBox`
  binds `this._onDestroy` at construction, so a subclass method by that name
  replaces the shell's own teardown and leaks the popup menu and the panel
  container, with no error. ESLint refuses it.

## Testing

Logic changes need tests, and there is no excuse not to write them: the hardware
adapters are driven by `test/helpers/fake-sysfs.js`, which takes a plain
`path → contents` map. Describing a machine is a few lines
(`test/hardware/gpu-xe.test.js` is a good model). `test/integration.test.js`
drives a whole described laptop through the real registry, Monitor and
presentation, and asserts on the exact strings a user sees — extend it when
behaviour changes shape.

Test *quality* is worth checking, not assuming, and here it is checked: `make
mutate` applies every deliberate defect in `tools/mutants.json` — a counter read
at the wrong edge, a widened ratio, a dropped guard — and requires the suite to
catch each one. A survivor is a gap. A mutant whose anchor no longer matches the
source is worse and also fails the run: it is a check that quietly stopped
checking, which this repository has been caught by more than once.

So if you add a rule, add the mutant that breaks it, and watch it go red before
you trust the test you wrote. A mutant aimed at `src/sysfs/gio.js` carries
`"suite": "gjs"`, because Node cannot load that module and would report every
such defect as caught by a suite that never saw it.

Beyond the code, the suite also holds the repository to itself:
`test/docs.test.js` checks that every `make` target the prose — or a workflow —
names exists, and that every file they point at is really there;
`test/conventions.test.js` holds every file to the `.editorconfig` rules nothing
else enforced; `test/tools/mutants.test.js` catches a mutant whose anchor has
drifted in milliseconds rather than after the three-minute run; and
`test/modules.test.js` checks that every shipped module — and every file under
`tools/` — is exercised by some test. All of them exist because the thing they
check had already drifted.

The tools are held to that standard because they are guards: they decide whether
a package is sound, whether an Action pin is real, and whether the tests are
worth anything. Each of them runs against a tree where it passes, so none of
their refusals fires unless a test makes it — and two of the three turned out
not to work the first time someone looked. If you add one, add the cases that
make it say no.

`prefs.js` has a suite of its own, `make test-prefs`, which imports the real
module and drives `_keepOrdered` through actual `Adw.SpinRow` objects. It is not
in `check` because it needs GNOME Shell's data files and a display; CI runs it
in a separate job, and on a GNOME desktop it just works. What makes it possible
is that the Extensions application ships its JavaScript as a GResource, so
`resource:///org/gnome/Shell/Extensions/…` resolves in any GJS process once
`Gio.resources_register()` has loaded it. The shell's own `js/ui/` is not
packaged that way, which is why `extension.js` stays parse-checked.

The Gio adapter is the only module Node cannot reach; its test lives in
`test/gjs/` and runs under `gjs`. `test/gjs/stack.gjs.js` runs the pure layers
there too — Node and SpiderMonkey track different ECMAScript releases, and a
syntax the shell rejects would otherwise reach users unchecked.

`test/gjs/smoke.gjs.js` is the only test that substitutes nothing: the real
registry, the real port, and whatever `/sys` the machine running it has. It can
therefore assert only what holds on any machine, and prints what it found. On
hardware that output is the closest thing this project has to evidence — see the
standing entry in `BACKLOG.md`.

## Releasing

`metadata.json`'s integer `version` is the single source of truth —
`package.json` deliberately carries no version. Bump it, replace the
`## [N] — unreleased` heading in `CHANGELOG.md` with the release date, and push a
matching tag (`v1` for version 1).

The release workflow refuses a tag that disagrees with `metadata.json`, and
refuses one whose changelog heading is missing or still says "unreleased" — a
published extensions.gnome.org version cannot be taken back, and the release
notes are the only thing a user reads before upgrading.

A green gate is not a reason to tag. `extension.js` and `prefs.js` are only
parse-checked, and no automated check here has ever run against silicon that
throttles — see [`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md) for the pass
to make on a real machine first, and what it can and cannot establish.

## What this project will not do

It does not read temperatures and call them throttling, it does not require
root, it does not run subprocesses, and it does not make network requests. A
change that needs any of those is a change to the project's premise — raise it
before building it.
