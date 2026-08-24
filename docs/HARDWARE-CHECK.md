# Checking this on real hardware

Everything in this repository is verified against mainline kernel source and
against machines the test suite describes. None of it has been observed on
silicon that actually throttles, and no automated check in this project can
change that — which is the standing entry in [`BACKLOG.md`](../BACKLOG.md) and
the reason version 1 sits on `main` untagged.

This is what to do about it, in the order that gets the most evidence for the
least setup. Stage A needs a clone and `gjs`; stage B needs a GNOME session and
a logout. Stage A is where most of the risk lives, so do it even if there is no
time for stage B.

What a clean run buys is narrow and worth stating plainly: it says these rules
answered correctly on *one* machine. It does not retire the entry above for
anyone else's.

---

## Stage A — no install, about two minutes

```bash
git clone https://github.com/gheylen/gnome-thermal-monitor
cd gnome-thermal-monitor
gjs -m test/gjs/smoke.gjs.js
```

That runs the real driver registry, the real Gio port and this machine's actual
`/sys` — no fake anywhere — and prints the verdicts the panel would show. It
asserts only what must hold on any machine, because what it finds depends
entirely on the machine.

Read the printout against what you know is in the box:

- **Every component you expect is listed.** A Core Ultra laptop should report a
  CPU, one GPU section per graphics tile, and an NPU. A missing section means
  discovery did not match a path; the `#   no <category>` lines say which.
- **The CPU section names a real temperature and trip point.** `18°C below the
  throttle point (100°C)` — the second number is this part's TjMax, read from
  `tempN_crit`. If it is 100 °C on a part you know runs to 105, the kernel had
  to guess it, which is fine: the difference is what the verdict turns on, and
  it stays exact either way.
- **A "Core N at …" line appears only if a core is closer to its own trip point
  than the package sensor is.** On an idle machine it will not, and that is
  correct. To make it appear, load one core hard: `taskset -c 0 sh -c 'while
  :; do :; done'`, then run the smoke script again in another terminal.
- **An Intel GPU section reads a frequency and a ceiling.** `1900 / 2050 MHz`
  with both numbers plausible means the xe or i915 attribute paths resolved. A
  section reading `No data` with a `?` in it means they did not.
- **An AMD GPU section reads a temperature instead**, because `amdgpu` publishes
  no boost ceiling to measure a frequency against: `edge at 61°C, 39°C below its
  throttle point (100°C) — 500 MHz`, with a channel named `edge`, `junction` or
  `mem`. This backend has never run on the silicon, so of everything on this
  page it is the line most worth reading carefully: a wrong channel or a `_crit`
  that is not the trip point would look exactly like a correct one.
- **`would notify:` renders.** On a nominal machine it says "A component is
  thermally throttling", which is the fallback — the line proves the wording
  builds, not that anything is wrong.

Then load the machine until it throttles — a kernel build, `stress-ng
--cpu $(nproc)`, or anything that makes the fans work — and run it again. The
CPU section should reach `████ CONFIRMED` and name a count of cores.

**Paste that output into an issue whether it looks right or wrong.** If it is
wrong, the sysfs file it disagrees with turns straight into a fixture in
`test/hardware/` and a failing test; that conversion is the whole point of the
printout.

---

## Stage B — installed, in a real session

```bash
make install                                     # symlink; does not copy
# log out and back in — a Wayland session cannot restart the shell in place
gnome-extensions enable thermal-throttle-monitor@gheylen.github.io
journalctl -f /usr/bin/gnome-shell | grep ThermalThrottleMonitor
```

Stage A cannot reach any of the following, because `extension.js` and `prefs.js`
import GNOME Shell modules that only exist inside their own processes. The test
suite parses both under the real engine and can say nothing else about them.

- **It enables at all.** The floor is GNOME Shell 46, and the code is written to
  it: `MessageTray.Source` takes a `params` object from 46, where 45 took
  positional arguments. An extension that will not enable is what that boundary
  produces when it is got wrong, and it is loud: the journal says so.
- **The panel renders and is coloured.** Nominal is the panel's own foreground;
  approaching a trip point is amber, reaching one is orange-red, and a confirmed
  throttle is the shell's own error red — the ramp only reads as a ramp if all
  four are distinguishable on your theme. `hide-when-nominal` should make the
  indicator disappear entirely and come back on a warning.
- **The popup sections read as the README shows them.** Badge, summary, and a
  detail line that is absent rather than blank when a component has nothing to
  add.
- **The notification.** This is the largest thing no test can execute. Turn on
  "Notify on throttling" in preferences, then throttle the machine. Check four
  things: a banner appears; it is attributed to *Thermal Throttle Monitor*
  rather than to *System*; it names the component; and **it is still in the
  message list afterwards**, because a throttle that happened while you were
  away is the one most worth finding later — that last one is what the
  extension's own notification source buys, and the easiest to get wrong.
- **Teardown.** `gnome-extensions disable …` should remove the indicator with no
  gap left in the panel, and take any unread notification of ours with it. Then
  re-enable it. Nothing in the journal either way.
- **Preferences.** `gnome-extensions prefs …`. Changing the poll interval should
  take effect without a restart, and changing a threshold should redraw the
  popup without polling the hardware again. The row-ordering behaviour has its
  own suite now — `make test-prefs`, which on a GNOME desktop needs nothing
  installed — so run that too and you are only looking at the window itself.

---

## While you are there

Three backlog entries need exactly this setup and will never be cheaper to
close. None of them blocks a release; all three have sat open because nobody has
had a session and the hardware at the same time.

- **A screenshot.** `README.md` carries a hand-maintained ASCII mock of the
  popup and a commented-out image reference beside it. Capture the panel
  indicator with the popup open, in a non-nominal state — amber or red, so the
  colours are doing something — save it as `assets/screenshot.png` under about
  300 KB, and uncomment the line.
- **Whether the popup wants a column.** Each row is one label reading
  `<badge>   <summary>`, so the summaries start at different offsets. Look at it
  and decide whether it is worth splitting the row into two labels with a fixed
  width on the badge. The panel font is proportional, so padding with spaces
  would not produce a column either — only a width would.
- **The accessible names, with Orca running.** Each status row carries a
  `spoken` form without the block-glyph badge, which a screen reader would
  otherwise announce as four black squares. The string is tested; whether ATK
  prefers it over the label's own text is not, because that needs Orca attached.

## If it all holds

Release is three steps, and the workflow refuses each of them if they disagree:

1. Replace `## [1] — unreleased` in `CHANGELOG.md` with `## [1] — YYYY-MM-DD`.
2. Commit that.
3. `git tag v1 && git push origin v1`.

The release workflow checks the tag against `metadata.json`'s integer version,
refuses a changelog heading that is missing or still says "unreleased", runs the
whole gate again, and publishes the zip. A published extensions.gnome.org
version cannot be taken back, which is why the heading is a gate and not a
convention.

Whatever the outcome, please add a line to `BACKLOG.md`'s standing entry saying
which machine ran it and what it found. That entry has been true since the first
release; the first time it stops being entirely true is worth recording.
