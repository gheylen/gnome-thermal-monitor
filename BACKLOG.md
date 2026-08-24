# Backlog

Everything found during review lands here rather than being dropped, in one of
three sections, and which section an entry is in is the whole point:

- **Validated against the kernel** — what the source passes left genuinely open.
- **Deferred work** — worth doing; nobody has.
- **Decisions, not debt** — known, reasoned, and deliberately not done. Read the
  reasoning before reopening one.

Most entries under *Deferred work* need something no amount of time at a keyboard
supplies: hardware, a running GNOME session, or a person who wants to translate
it. [`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md) is where the first two
kinds get done, and it names the three that are cheapest to close during a pass
that is happening anyway. The exception is the prose guard below, which is
ordinary work nobody has done.

## Validated against the kernel

The rules were checked against mainline sources in August 2026, in three passes:
`drivers/thermal/intel/therm_throt.c`, `arch/x86/include/asm/msr-index.h`,
`drivers/hwmon/coretemp.c`, `drivers/hwmon/k10temp.c`,
`drivers/gpu/drm/i915/gt/intel_gt_sysfs*.c`, `drivers/gpu/drm/i915/i915_sysfs.c`,
`drivers/gpu/drm/i915/gt/intel_rps.c`, `drivers/gpu/drm/i915/i915_reg.h`,
`drivers/gpu/drm/xe/xe_gt_{freq,idle,throttle}.c`,
`drivers/gpu/drm/xe/xe_pm.{c,h}`, `drivers/accel/ivpu/ivpu_sysfs.c`,
`drivers/base/power/sysfs.c`, and
`Documentation/ABI/stable/sysfs-devices-system-cpu`.

Between them those passes found signals modelled wrongly, a fix that did not
work while a comment said it did, a platform left with no thermal signal at all,
attributes the drivers publish that the rules were not reading, and several
claims that were merely plausible — including the project's own headline word
for what the CPU counter measures. All of it was fixed before the first release,
and the count is not the point: each was internally consistent and agreed with
its tests. One thing they left open is below; the rest of what they turned up is
under the two sections after it, filed by whether anyone should act on it.

The lesson worth keeping: in every pass the tests agreed with the code and both
were wrong together, because the fixtures had been written from the
implementation. A test suite proves consistency. Only the driver source proves
correctness.

### No machine with the hardware has ever run this
Every verdict in this project has been checked against the kernel source and
against described machines in the test suite. None of it has been observed on a
machine that actually throttles. The errors those passes found — a counter read
at the wrong edge, an entire adapter looking in the wrong directory, a fix that
could not work — were all invisible to a test suite whose fixtures were written
from the implementation. That is the standing risk here, and only a report from
real hardware retires it.

There is now a way to produce one without installing anything.
`test/gjs/smoke.gjs.js` runs the real registry, the real Gio port and this
machine's actual `/sys` — no fake anywhere — and prints the verdicts the panel
would show:

```bash
gjs -m test/gjs/smoke.gjs.js     # or: make test-gjs
```

It asserts only what must hold on any machine, because what it finds depends
entirely on the machine. On the container this was written in it finds nothing
and says so, which is itself a case nothing else covered. On a laptop it prints
the real readings, and that output pasted into an issue is a bug report someone
can act on.

[`docs/HARDWARE-CHECK.md`](docs/HARDWARE-CHECK.md) is what to do with a machine
that has the hardware: what the printout should say, what to load to make a
throttle happen, and the things only an installed session can answer. **A
verified machine belongs in the list below** — this entry has been true since
the first release, and the first time it stops being entirely true is worth
recording.

Machines this has been run on: *(none yet)*

## Deferred work

### The AMD CPU backend has never run on AMD hardware
`src/hardware/cpu-amd.js` is written from the documented `k10temp` sysfs layout.
`test/hardware/cpu-amd.test.js` pins every assumption it makes — sensor
preference, the unlabelled fallback, the empty core array — so a report from an
AMD user can be turned into a failing test in one step. Until someone runs it,
the README and the module header both say experimental.

### NPU confidence is capped at LOW by construction
`intel_vpu` publishes a frequency, a maximum and a busy-time accumulator, and
nothing about throttling. Running below maximum is equally consistent with a
light workload, so `src/domain/npu.js` never exceeds `LOW` while the NPU is
running. If a future kernel exposes a thermal or throttle node, that cap should
lift — and only then.

### The AMD GPU backend has never run on AMD hardware
`src/hardware/gpu-amd.js` is written from the interface `amdgpu_pm.c` documents
in its own source: `temp[1-3]_input` and `temp[1-3]_crit` per edge/junction/mem
channel, and `freq1_input` in hertz. `test/hardware/gpu-amd.test.js` pins every
assumption it makes — the channel set, the units, the emergency threshold it
must *not* read — so a report from someone with the card can be turned into a
failing test in one step. Until then the README says experimental, as it does
for the AMD CPU backend and for the same reason.

### No backend for NVIDIA or ARM SoCs
Two different reasons, and only one of them is work anybody should do.

**NVIDIA is a non-goal.** `nouveau` publishes no throttle reason, and the
proprietary driver's is behind NVML — a library call or a subprocess, which is
the one thing this project's premise rules out ("it does not run subprocesses").
A temperature-only NVIDIA backend would be possible through `nouveau`'s hwmon,
but a card whose driver is the proprietary one publishes nothing there.

**ARM SoCs are deferred, and the obstacle is not the ABI.**
`/sys/class/thermal` is documented and stable: `thermal_zoneX/temp`,
`trip_point_Y_type` of `critical`/`hot`/`passive`, and cooling devices whose
`cur_state == 0` the ABI defines as "no cooling". A `passive` trip is genuinely
where the kernel's governor starts capping frequency, which is a real throttle
point rather than the programmable threshold `x86_pkg_temp` publishes.

What stops a generic zone backend is the other end: an ordinary x86 laptop
registers zones for `acpitz`, the wifi card, every NVMe device and more, and a
backend that took them all would add half a dozen junk sections to the popup of
every user this project actually has. Making it useful needs a platform-scoped
list of which zone `type` values are the SoC — and getting that right needs the
hardware in front of you. Worth doing by someone holding an ARM board; not worth
guessing at.

### Nothing holds the user-facing prose to the code it describes
The strings a user reads outside the popup — `prefs.js`'s row subtitles, the
GSettings schema descriptions, the README's settings table and colour legend —
are prose, and prose is the one thing here with no guard on it. One audit pass
found four drifted claims at once: both threshold rows promised a colour the
level does not produce (`temp-crit` said "red", which `stylesheet.css` reserves
for a counter-confirmed throttle, and both said "above" where the predicate is
`>=`), the README still described the critical threshold as "throttling
imminent" — the wording taken out of the CPU rule for overstating what a typed
number knows — and both the README and `CATEGORY_WARNINGS` still listed the GPU
drivers as "xe or i915" months after the amdgpu backend shipped.

All four are fixed. What is not fixed is that the next one will happen the same
way, because `test/docs.test.js` checks that the prose names real files and real
`make` targets, and nothing checks that it describes real behaviour.

A full guard is not obviously possible — "amber" is not derivable from
`#cd9309`. Two partial ones are, and either would have caught three of the four:

- Assert that the strings in `prefs.js` and the schema descriptions agree with
  each other, since they document the same five keys twice. `make test-prefs`
  already loads the real `prefs.js`, so it has both in hand.
- Assert that no shipped file names a driver that is not in `DRIVERS`, which
  turns "the supported set changed" into a failing test rather than a reader's
  discovery.

Neither is hard. Both were skipped here because inventing a checker for prose is
how a check that enforces nothing gets written, and this repository has shipped
two of those already.

### The README still ships an ASCII mock instead of a screenshot
The mock is maintained by hand and will drift from the real popup. What is
wanted is the panel indicator with the popup open, in a non-nominal state
(amber or red), saved as `assets/screenshot.png` — under about 300 KB, so the
repository stays lean. Uncommenting the image reference near the top of
`README.md` is the only other change needed.

### The popup's badge and summary do not form a column
Each popup row is one label reading `<badge>   <summary>`, so the summaries
start at different offsets — the badge words differ in length. A true column
needs the row split into two labels with a fixed width on the badge, which is
CSS and St layout that cannot be checked without a GNOME session; guessing at
layout is how the last few rounds of bugs happened. The README shows the output
as it actually renders, and `test/presentation.test.js` holds it to that, so at
least the documentation cannot drift back into claiming an alignment the code
does not produce.

Worth knowing before attempting it: the panel font is proportional, so padding
with spaces would not produce a column either — only a width would.

### The popup's accessible names are unverified against a live screen reader
`src/presentation.js` produces a `spoken` form of each verdict — the same
information without the block-glyph badge, which a screen reader would otherwise
announce as four black squares — and `extension.js` assigns it to each status
row's `accessible_name`. The string itself is tested; whether ATK prefers that
name over the label's own text is not, because it needs a GNOME session with
Orca attached. The assignment is harmless either way: it changes nothing
visually and nothing about the label text.

### `extension.js` is only parse-checked
`test/gjs/stack.gjs.js` confirms the GJS parser accepts it, which catches the
failure mode where the extension simply will not enable. Beyond that it needs
GNOME Shell's own `js/ui/` modules — `St`, `PanelMenu`, `PopupMenu`,
`MessageTray` — and those are not shipped as a registrable GResource the way the
Extensions application's are: on Ubuntu 46 they are linked into the `gnome-shell`
binary itself, where `gresource list` cannot reach them and
`Gio.resources_register()` has nothing to load. So
`resource:///org/gnome/shell/ui/main.js` cannot resolve outside a running shell,
and that is a fact about packaging rather than a gap somebody could close with
more effort here.

`prefs.js` was in this entry until its half turned out to be possible — see
`make test-prefs`. What made the difference was that the Extensions application
*does* ship its JavaScript as `org.gnome.Shell.Extensions.src.gresource`.

It is kept deliberately thin for exactly this reason: every decision it renders
is made in `src/domain/` and worded in `src/presentation.js`, both fully covered.
A headless shell in CI would close the gap at a cost well above its value today.

What is genuinely unverified is small and named: the notification source's
lifecycle — that `MessageTray.Source`, `Main.messageTray.add()`,
`addNotification()` and the `destroy` signal behave as GNOME Shell's own
message-tray module says they do. Every line of it was written against the
shell's own `getSystemSource()`, which is the same three lines for the same
reason, and its wording lives in `throttleNotification()` under Node. The icon
name was checked rather than guessed — `dialog-warning` is a Status name in the
freedesktop Icon Naming Specification and its `-symbolic` variant is in Adwaita
at the floor and on current main — because a name a theme lacks renders as a
broken image rather than falling back.

## Decisions, not debt

### English only, until someone offers a translation
`metadata.json` declares no `gettext-domain` and every user-visible string is an
English literal. This is a decision with a stated trigger rather than work
nobody has got to, and the trigger is a translator: shipping the machinery
before there is a `po` file to run through it buys nobody anything and puts an
indirection in front of every sentence this extension says.

What it would cost is knowable, so here it is rather than a shrug.

`extension.js` and `prefs.js` can import `gettext` directly, each from the
`resource://` module it already imports its base class from, so the panel chrome
and the preference rows are the easy half. `src/domain/` and
`src/presentation.js` cannot: the layering forbids them a `resource://` import,
and `eslint.config.js` enforces it.

So a translator has to be *injected*, the way the Sysfs port is. Every rule
already receives a `context`; a `t(msgid, …args)` on it, defaulting to an
identity function, would let `src/domain/` keep its own wording — gettext msgids
are English, so nothing moves — while the shell adapter supplies the real one.
Roughly twenty-five sites across `cpu.js`, `gpu.js`, `gpu-temperature.js`,
`npu.js`, `temperature.js` and `presentation.js`, each becoming a call with
positional arguments instead of a template literal, plus `ngettext` where a
count is involved ("1 of 8 cores" against "2 of 8"). Then a `po/` tree, an
`xgettext` step in the Makefile, and `gettext-domain` in the manifest.

The trap to avoid when it happens: with an identity translator every existing
string test passes whether or not a site was actually converted, so the suite
would certify a half-translated extension. The conversion needs a test that
injects a *marking* translator and asserts every user-visible string came back
marked — otherwise this is the "check that matches nothing" shape, three times
over.

The alternative design — rules emitting structured facts for a formatter in
`src/presentation.js` to word — is the stricter reading of DDD and is what
`docs/ARCHITECTURE.md` calls the seam to split along. It is also a great deal
more machinery, and injection gets the same result while leaving each rule's
sentence beside the reasoning that produced it.

### The i915 sections are named after kobjects, the xe ones after engine roles
`gpu-xe.js` resolves `gtidle/name` to `Render` or `Media/Codec`; i915 has no such
attribute, so its sections read `GPU — gt0` and `GPU — gt1`. On a Meteor Lake
i915 machine with a render GT and a standalone media GT, the user sees two
sections distinguished only by a kernel index. The mapping is knowable in
practice — gt0 is render, gt1 is media — but it is a convention, not something
the driver states, and this project does not present a guess as a fact.

### Every sysfs read is synchronous, on the compositor thread
`src/sysfs/gio.js` uses `load_contents`, `enumerate_children` and `query_info`
synchronously, so a `show` handler that takes a mutex or resumes a device does
so with GNOME Shell's main loop blocked behind it. Nothing read today is known
to be slow — the adapters were audited attribute by attribute for exactly this —
but the property is a standing constraint on every future backend rather than
something the port guarantees.

Gio's `*_async` variants would remove the constraint, at the cost of making
`read()` return a promise and therefore `Monitor.poll()` asynchronous, which
reaches the linger, the notification edge and the settings-change path. That is
a large change to make against a hypothetical. The cheaper half — a per-poll
budget, or refusing to read an attribute a backend has declared expensive — is
worth considering first if a slow attribute ever turns up.

### Polling continues while the session is idle but unlocked
The timer runs at the configured interval for as long as the extension is
enabled, so an unattended-but-unlocked laptop keeps reading sysfs every few
seconds for a panel nobody is looking at. The count scales with the machine:
three attributes per logical CPU, two per core temperature channel, and a
handful per GPU tile. A described sixteen-thread laptop with two GT tiles and an
NPU takes 84 reads per poll while nothing is throttling — measured against the
fake port, not estimated.

Not while *locked*, though — an earlier version of this entry said otherwise and
was simply wrong. `metadata.json` declares no `session-modes`, so GNOME Shell
gives it the default `["user"]` and disables the extension when the session mode
becomes `unlock-dialog`. `disable()` destroys the indicator, whose `destroy`
handler clears both timers. Nothing polls behind a lock screen. That is a
property worth not losing: adding `unlock-dialog` to `session-modes` would turn
polling back on for a panel that is not on screen, and `test/release.test.js`
pins the absence.

For the idle case, pausing would be safe — every counter this extension reads is
cumulative, so a wider gap between polls loses no event, only delays noticing
one. It is not done because the lever is not a stable one: the idle monitor and
`Main.screenShield` are shell internals rather than documented extension API,
and their shape has moved between releases. This project has already been bitten
once by reaching into `PanelMenu.ButtonBox`'s private surface, and the saving
left over — an idle, unlocked, plugged-in machine — does not justify a second
such dependency.

### The GJS suite runs on the floor today, but nothing holds it there
`metadata.json` claims GNOME Shell 46, which ships GJS 1.80 on SpiderMonkey 115.
The `ubuntu-latest` runner and this container both carry 1.80, so `make
test-gjs` is currently evidence about the oldest shell this extension claims —
which it was not while the floor was 45 and its GJS 1.78 was older than anything
installable. The harness works that out from `System.version` rather than
claiming it in prose, and prints "the floor itself" or "ahead of the floor"
above every suite.

Nothing pins it: `ubuntu-latest` will move on, and the line will start saying
"ahead of the floor" without anything failing. That is the right behaviour — a
newer engine is not a reason to fail a build — but it means the guarantee is a
coincidence of the runner rather than a property of the project. The standing
guard is `eslint.config.js`, which refuses post-115 built-ins by name in shipped
code and parses it at ES2022. Genuinely pinning the floor would mean a container
per supported shell version, which is a lot of machinery for a constraint a
five-line lint rule already covers.

### The thermal-zone fallback has no throttle point
A machine without `coretemp` falls back to the `x86_pkg_temp` thermal zone for
its temperature, and that path offers no TjMax: the zone's `trip_point_N_temp`
attributes are the *programmable* thermal thresholds the kernel arms for
interrupts, not the trip point the hardware throttles at. The rule degrades to
the user's settings alone, which is correct but blind. `MSR_IA32_TEMPERATURE_TARGET`
holds the value and nothing world-readable exposes it on that path.

### `tempN_crit_alarm` is a real signal with no timestamp
`coretemp` exposes `tempN_crit_alarm` as bit 5 of `IA32_THERM_STATUS` — the
*Critical Temperature Status Log*, which is the catastrophic threshold well above
TjMax, not TCC activation. It is a sticky log bit: once set it stays set until
something clears it, with no indication of when the event happened. Surfacing
"this machine has been in thermal emergency at some point since boot" is
arguably worth doing, but not as current state, and this extension has no way to
tell a reading from three days ago from one a second ago.

### The power-limit counters are deliberately not read
`therm_throt.c` also publishes `core_power_limit_count` and
`package_power_limit_count` where `X86_FEATURE_PLN` is present and
`int_pln_enable` was passed. They are not read, and this is a decision rather
than a gap: a power limit is not a thermal event, and the whole premise of this
project is refusing to present one as the other. The GPU rule makes the same
call about `throttle/status`, which is asserted under PL1 on nearly any real
workload. If they are ever surfaced it must be as their own thing, at a level
that cannot reach `CONFIRMED`.

### The poll interval is capped at 60 seconds
The CPU throttle counters are read as deltas between polls, so the interval is
the resolution of every "N cores throttled" answer. At an hour, a one-second
burst and an hour of sustained throttling are the same reading. (The linger
itself is safe at any interval — a one-shot timer draws the panel when the
window closes — but a number that coarse is not worth reporting.) The schema and
the preferences agree on 1–60 s; the schema is the enforcing authority.

### `hide-when-nominal` also hides on UNKNOWN
A machine with no readable sensors has nothing to report, so the setting hides
the indicator rather than showing a permanent `?°C`. The trade-off is that a
misconfiguration (an unloaded `coretemp`, say) looks the same as a healthy
machine. The startup warning in the journal is the intended way to notice that;
`CATEGORY_WARNINGS` in `src/hardware/index.js` fires once per missing category.

### The panel shows the CPU package temperature only
No current backend reads a GPU or NPU temperature, so the label falls back to
`?°C` when the CPU sensor is missing even though other components may be
reporting. Showing a GPU temperature in a slot labelled by a CPU-shaped rule
would be worse than showing nothing.

It stays the *package* sensor now that the rule also reads the per-core
channels. The panel is one number, and the package DTS is the one every other
tool means by "the CPU temperature"; a label that silently switched to whichever
core happened to be hottest would jump between sensors poll to poll. The core
that is closest to its own trip point is named in the popup instead, with its own
reading, so the line stands on its own beside a lower panel number. The two user
thresholds are compared against the package for the same reason: a preference is
a statement about the figure on screen.

### Both CPU drivers can theoretically discover at once
`cpu:intel` matches `coretemp` / `x86_pkg_temp`; `cpu:amd` matches `k10temp`.
No shipping machine exposes both. If one did, the ids stay distinct, so nothing
corrupts — the popup would simply show two sections titled "CPU", and the first
one discovered would supply the shared package temperature. Making the `cpu`
category exclusive would add a concept to the registry to solve a problem nobody
has.

### The distributable zip carries the schema source, not the compiled schema
`make pack` compiles the schema to validate it and then excludes
`gschemas.compiled` from the zip: extensions.gnome.org recompiles schemas
itself, and its review guidelines ask submissions not to carry files they do not
need in order to function. The `.gschema.xml` source is required and is
included. Installing straight from the zip by hand therefore needs one
`glib-compile-schemas` run; `make install` does it for you.

### A reassessment may close a linger window, though it opens none
`Monitor.reassess()` re-answers the last poll against new thresholds and is
otherwise forbidden from touching the state a poll advances — it must not
extend the linger, and it must not fire a notification. Closing an expired
window is the one exception, and it is deliberate.

The alternative was worse. The deadline used to be cleared only by a poll, so
between the window running out and the next poll, a settings write — a spin
button sends one per step — reported `CONFIRMED` from a window that had already
closed, while a poll at that same instant would have said `LOW`. Two answers
about one moment is precisely what this project exists not to produce.

So expiry is decided where the deadline is read rather than where it is set,
which makes both paths agree by construction. The cost is that `reassess()` is
no longer a pure function of the last poll and the thresholds: called before and
after the deadline it answers differently, and the second call clears the field.
That is the truth about the clock rather than a side effect of the call, but it
is a real weakening of the method's contract and is written down here rather
than left for the next reader to find in a diff.

### The Sysfs port is a module-scope constant
`src/sysfs/gio.js` exports `gioSysfs` rather than a factory called from
`enable()`. The extension review guidelines forbid creating objects during
initialisation but explicitly permit "static data structures and instances of
built-in JavaScript objects" — this is a frozen record of three plain functions
holding no GObject and no resources, so it qualifies. A factory would be more
symmetrical with the composition root in `extension.js`; it would also be
ceremony for no gain.

### The xe throttle gate is reasoned, not observed
`src/domain/gpu.js` honours the thermal reason flags and `reason_prochot` only
when `throttle/status` is not explicitly `0`, so a latched reason bit cannot
produce `CONFIRMED` while the driver says nothing is throttling. That ordering
follows from the register names and from this project's rule about not
overstating, not from watching a real GT latch a bit. If an xe GPU is ever seen
setting a reason without setting status during a genuine throttle, this gate is
what would hide it — the popup would fall back to the frequency shape.

### GPU idle detection matches the C6 substring, not an exact state list
`src/hardware/gpu-xe.js` treats any `gtidle/idle_status` containing `c6` as
parked, which covers the render (`rc6`) and media (`mc6`) engines without
pinning the exact string set the driver emits. If the xe driver renames those
states, this degrades to "not idle" — a `LOW` verdict rather than `IDLE`, which
is wrong but not alarming. Pinning the exact set would need the kernel's own
list, which is not published as a stable sysfs ABI.

### Alert colours are hardcoded hex values
`stylesheet.css` uses the same `#d61f2d` and `#cd9309` GNOME Shell uses for its
own error and warning states. GNOME exposes no semantic colour to extension
stylesheets — `-st-accent-color` is the user's brand accent, not a warning
signal — so tracking a theme change means editing these values. Each level has
its own CSS class precisely so a theme can override one without forking.

### `gitleaks-action` stays on v2
A Dependabot pull request offering v3.0.0 was closed rather than merged. v3 is a
major release of a secret-scanning action whose licensing terms differ by
account type, and reversing that decision is not something to do on the strength
of "a newer tag exists". The v2.3.9 pin is verified and the scan runs on every
push. If the intent was simply to defer, the bump is a one-line change plus
`make verify-pins`.

### `shell-version` claims 46 through 50
The extension only uses APIs stable across that range (ESM `Extension`,
`PanelMenu.Button`, `MessageTray.Source`/`Notification`, `Adw.SpinRow`/
`SwitchRow`). Testing happens on current GNOME; the older entries are a
compatibility claim, not a tested one. Trim the list if a report shows it is
wrong.

45 is deliberately not in it. `MessageTray.Source` took a positional
`(title, iconName)` there and `Notification` took `(source, title, banner)`;
both became `params` objects in 46, and `showNotification()` became
`addNotification()`. Supporting both would mean branching on a shell version at
runtime in the one file no test can execute — the shim this project would rather
not carry than the shell release it would buy. GNOME 45's only shipping home was
Ubuntu 23.10, out of support since July 2024; 24.04 LTS ships 46.
