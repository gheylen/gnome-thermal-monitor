# Architecture

A GNOME Shell extension is an awkward thing to test: it runs inside the
compositor, it talks to a kernel interface that only exists on the right
silicon, and a thrown exception takes the user's desktop with it. This codebase
is arranged so that almost none of it needs any of that to be verified.

## The dependency rule

Everything points inwards. An inner layer never knows what is outside it.

```
                    ┌──────────────────────────────────────────┐
                    │  extension.js · prefs.js                 │  GNOME Shell
                    │  St widgets, GLib timers, GSettings      │  adapters
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │  src/presentation.js                     │  wording,
                    │  badges, CSS classes, panel text         │  glyphs, a11y
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │  src/domain/                             │
                    │    confidence.js  the vocabulary         │  the rules
                    │    thresholds.js  the temperature pair   │
                    │    cpu · gpu · npu   assessment rules    │
                    │    monitor.js     the Monitor aggregate  │
                    │    discovery.js   registry → components  │
                    └────────────────▲─────────────────────────┘
                                     │ Sysfs port (injected)
                    ┌────────────────┴─────────────────────────┐
                    │  src/hardware/   driver adapters         │  kernel
                    │  src/sysfs/      port + Gio adapter      │  adapters
                    └──────────────────────────────────────────┘
```

Three consequences, and they are the whole point:

- **`src/domain/` and `src/presentation.js` never import `gi://`.** They run
  under plain Node, so the rules and every user-visible string are covered by
  ordinary unit tests.
- **`src/hardware/` never imports `gi://` either.** Each adapter receives a
  Sysfs port and asks it for text, integers and listings. Tests hand it an
  in-memory tree (`test/helpers/fake-sysfs.js`) and describe a machine.
- **`src/sysfs/gio.js` is the only module in the read path that touches the
  GJS runtime.** It is small, it is boring, and it is tested under a real GJS
  interpreter (`test/gjs/sysfs-gio.gjs.js`). `test/gjs/stack.gjs.js` additionally
  walks the pure layers on that engine and confirms it accepts both entry
  points, because Node accepting the syntax does not prove SpiderMonkey will.

Each module is also refused the imports it has no business making, not only the
runtime ones: `src/presentation.js` may read the domain vocabulary and nothing
below it, and `src/sysfs/port.js` and `src/log.js` are leaves — every layer is
written against the port and may call the log, so neither may depend on a layer
in turn.

`eslint.config.js` encodes all of this as `no-restricted-imports` groups, so a
violation fails `make lint` rather than waiting for a reviewer. `make pack` then
re-checks it against the built zip via `tools/check-package.mjs`, which also
proves every module the entry points import actually made it into the archive —
the file list in the Makefile is maintained by hand, and lint and tests both run
against the working tree rather than the artifact.

## The pieces

| Module | Responsibility |
|---|---|
| `src/domain/confidence.js` | The confidence vocabulary, its severity order, and what counts as nominal or as throttling. |
| `src/domain/thresholds.js` | The warning/critical pair as a value object: ordered at construction, and the only place a temperature is compared against them. |
| `src/domain/cpu.js`, `gpu.js`, `gpu-temperature.js`, `npu.js` | One `assess(reading, previous, context) → Verdict` per hardware class. Pure functions over plain data. Two GPU rules, because a driver that publishes reason registers and one that publishes only temperatures are answering different questions. |
| `src/domain/temperature.js` | Headroom below a trip point, per channel, each against its own — the one thermal judgement that belongs to no particular silicon. Shared by the CPU and AMD GPU rules. |
| `src/domain/monitor.js` | The `Monitor` aggregate. Reads every component, shares the CPU package temperature between rules, picks the worst level, holds the throttle linger, and detects the notification edge. Produces one `Snapshot`. |
| `src/domain/discovery.js` | Turns the driver registry into components, tolerating a driver that throws and refusing duplicate ids. |
| `src/sysfs/port.js` | The port contract, strict integer parsing, and the natural ordering guarantee. |
| `src/sysfs/gio.js` | The production port, built on `Gio.File`. Never throws. |
| `src/hardware/*.js` | Discovery and reading for one kernel driver. Owns sysfs paths and nothing else. |
| `src/hardware/hwmon.js` | The hwmon layout both CPU backends share: find a device by driver name, pair a `tempN_label` with the attributes beside it, convert millidegrees. Knows no chip. |
| `src/hardware/index.js` | The registry: `DRIVERS` and `CATEGORY_WARNINGS`. |
| `src/presentation.js` | Badges, CSS class names, the panel label, the accessible name, popup lines, the notification's title and body. |
| `src/log.js` | The only module allowed to write to the journal. |
| `extension.js` | Wires the above together, owns the St widgets and the GLib timers, and draws `Snapshot`s. |
| `prefs.js` | Binds each settings key to a row. Holds no state. |

## A poll, end to end

1. `extension.js`'s timer fires and builds a `Thresholds` from the two GSettings
   integers, which orders them whichever way round they were stored.
2. `Monitor.poll()` calls `read()` on every component. Each one reaches sysfs
   through the injected port; a throw is caught and isolated to that component.
3. Any component offering a `temperatureC` projection contributes the CPU
   package temperature. The first non-null wins; it becomes
   `context.packageTempC`, together with that same component's
   `throttlePointC` — both from one sensor or neither, since a temperature from
   one channel and a trip point from another describe no hardware.
4. Every component's `assess()` runs against that shared context and the reading
   from the *previous* poll — the window advances only after all of them have
   seen it, so no rule can observe a half-advanced state.
5. The worst level wins. A confirmed throttle sets a linger deadline on a
   monotonic clock, so brief bursts stay visible for 30 seconds.
6. `extension.js` renders the `Snapshot` and schedules a one-shot timer for the
   linger deadline, so the panel clears promptly rather than at the next poll.

A settings change does **not** repeat that walk. `Monitor.reassess()` re-answers
the last poll's readings against the new thresholds and touches none of the
poll's state — not the delta window, not the linger, not the notification edge.
A spin button writes on every step, and polling for each would read all of sysfs
inside the compositor and chop the throttle-delta window into slivers a burst
could hide between. Changing the poll interval re-arms the timer and does not
poll either.

## Design decisions worth knowing

**Measurement and preference are different things.** When no counter has moved,
the CPU rule has two inputs and keeps them apart: the headroom below this part's
own trip point (`tempN_crit` — TjMax on `coretemp`, the HTC trip on `k10temp`),
which is a measurement, and the user's two temperature settings, which are a
preference. The measurement is taken on every channel the driver publishes —
the package sensor and each core's — against that channel's own trip point, and
the tightest answers; the preference is compared against the package alone,
because it is a statement about the number on the panel. Both produce a level,
the worse wins, and the wording attributes a level the hardware did not ask for
to the person who did. Before this the rule had only the preference, and
described it in the language of evidence.

**Confidence is the ubiquitous language.** The project exists because a
temperature is not a throttle. Only a hardware counter earns `CONFIRMED`:
the CPU's per-core thermal (TCC) event counter, or a GPU driver's PROCHOT
reason flag. The two are deliberately worded differently — see `src/domain/cpu.js`
for why the kernel's `THERM_STATUS_PROCHOT` is not the PROCHOT# pin.
Everything else caps at `HIGH`. The NPU, which publishes no throttle signal at
all, is pinned to `LOW` whenever it is running — see `src/domain/npu.js`.

**Verdicts carry their own wording, with one deliberate exception.** A stricter
reading of DDD would have the rules emit structured facts and a formatter turn
them into sentences. For `summary` and `detail` there is one presentation of the
data and no localisation, so that indirection would buy nothing and cost a
formatter per verdict shape. `src/presentation.js` owns the presentation
*technology* — glyphs, CSS class names, layout — and the rules own their
sentences.

The exception is `throttlingCount`, and it is instructive. It used to be
`panelSuffix: ' (3)'` — a rendered string, brackets and all — which meant the
number had exactly one way to read, and the accessible name shipped without it:
"(3)" is not something to say aloud, so it was simply dropped. Two audiences is
the same shape as two languages. The moment a fact needs to read more than one
way, the rule's job is to state it and presentation's job is to say it, twice.
That is also the seam a stricter reading of DDD would split along if
translations ever land — though `BACKLOG.md` argues for injecting a translator
instead, which reaches the same place without moving every sentence away from
the reasoning that produced it.

**The aggregate owns its collaborator contracts.** `Component`, `Context` and
`Verdict` are typedef'd in `src/domain/monitor.js` rather than in a module of
their own, so every rule refers to the aggregate for its own signature. That
looks backwards and is not: they describe what the `Monitor` requires of a
component and hands to a rule, and the party that states a requirement is the
one that owns it. `Snapshot` is its output and belongs there for the ordinary
reason. Nothing imports across at runtime — these are types — so there is no
cycle to break, only a direction to keep straight.

**The context is a value, not a mutable bag.** An earlier design let components
write into a shared `context` object during discovery. Components now expose an
optional `temperatureC(reading)` projection instead, and the Monitor builds the
context. Nothing mutates anything it does not own.

**Nothing in the read path throws.** The port returns `null` and `[]`; the
adapters return readings full of `null`; the rules answer `UNKNOWN`. The Monitor
catches anyway, because "must not throw" is a contract and contracts get broken.

## Adding hardware support

1. Write `src/hardware/<driver>.js` against the `Driver` contract in
   `src/domain/discovery.js`. It gets a Sysfs port; it must not import `gi://`.
2. Put the decision logic in `src/domain/`, as a pure
   `assess(reading, previous, context)` function.
3. Register the driver in `src/hardware/index.js`, and add a
   `CATEGORY_WARNINGS` entry if it introduces a new category — omit the entry
   for hardware that is genuinely optional, so its absence is not reported as a
   fault.
4. Give every component a globally unique `id` (`<category>:<driver>[:<index>]`).
5. Add tests: the rule under `test/domain/`, the adapter under
   `test/hardware/` using `fakeSysfs`.
6. Be honest about confidence. `CONFIRMED` means a counter said so.
