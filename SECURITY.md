# Security Policy

## Supported versions

Only the latest released version receives security fixes. Please ensure you
are running the most recent release before reporting an issue.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use one of the following:

- **GitHub private vulnerability reporting** (preferred): open the
  [Security tab](https://github.com/gheylen/gnome-thermal-monitor/security/advisories/new)
  and submit a private report.
- **Email**: heyleng@gmail.com

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
- Performs **no** network requests, shell execution, or file writes.
- Reads from a fixed set of `sysfs` paths via helpers that never throw.

The most relevant security properties are therefore input-handling
robustness (a malformed or unexpected `sysfs` value must never crash the
shell) and supply-chain integrity of the build/release pipeline.
