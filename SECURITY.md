# Security Policy

## Supported versions

Nothing has been released yet, so `main` is the supported version: build from
source and reproduce against the current commit. Once there is a release, only
the latest one receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Use **GitHub private vulnerability reporting**: open the
[Security tab](https://github.com/gheylen/gnome-thermal-monitor/security/advisories/new)
and submit a private report. It reaches the maintainer, nobody else can read it,
and the fix and the advisory are drafted in the same place.

There is deliberately no email address here. The address on this project's
commits is a GitHub `noreply` one, which exists so the author is identified
without publishing a mailbox — mail sent to it does not arrive anywhere. If you
cannot use private reporting, open a public issue that says only that you have a
security report and nothing about the vulnerability itself, and you will be given
a channel.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- The extension version (`metadata.json` → `version`) and GNOME Shell version.

You can expect an initial response within 7 days. Once a fix is available, a
new release will be published and the reporter credited (unless anonymity is
requested).

## Scope and threat model

This extension runs inside the GNOME Shell process. It:

- Reads **world-readable** files under `/sys` only — no privileged access.
- Performs **no** network requests and **no** shell execution, and writes no
  files. The only thing it stores is its own GSettings keys, and only when you
  change a preference: `prefs.js` binds each row to its key and holds no state,
  and nothing in the shell process writes at all.
- Reads a fixed set of `sysfs` paths through a single adapter
  (`src/sysfs/gio.js`) that reports missing data instead of raising.

The most relevant security properties are therefore input-handling robustness —
a malformed or unexpected `sysfs` value must never crash the shell — and
supply-chain integrity of the build and release pipeline.

Both are checked rather than asserted. Every value read from `sysfs` is parsed
strictly, and the test suite drives the hardware adapters against absent,
empty, unreadable, and malformed inputs (`test/hardware/`, `test/sysfs/`)
as well as against a real filesystem under GJS (`test/gjs/`). The rules are
additionally checked by mutation testing (`make mutate`): a defect introduced
deliberately must fail a test, so "the suite passes" means the suite would
notice.

For the pipeline: every GitHub Action is pinned to a commit SHA. `make check`,
which needs no network and so is the gate a contributor runs, refuses a `uses:`
that is a mutable tag or carries no version comment. `make verify-pins` goes
further and resolves each SHA against its upstream repository, checking that the
comment beside it names a tag really pointing at that commit; CI runs that too,
after `make check`, so a pin that stopped resolving is found on the pull request
rather than by whoever next opens one. CodeQL, Dependabot, and a secret scan run
on every change.
