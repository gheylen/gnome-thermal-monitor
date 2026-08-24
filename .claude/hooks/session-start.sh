#!/bin/bash
# SPDX-FileCopyrightText: 2026 G Heylen
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Make `make check` work in a fresh Claude Code on the web session.
#
# The gate needs three things this repository does not carry: ESLint and its
# parser from npm, `gjs` to run the tests Node cannot, and
# `glib-compile-schemas` to validate the GSettings schema. Without them an
# agent's first instinct — run the gate — fails for reasons that have nothing
# to do with the change it is making.
#
# Local checkouts are left alone: `npm ci` and the system packages are a
# developer's own business there.

set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Nothing here is fatal. A network hiccup during setup is a slower session, not
# a broken one — and a hook that aborts leaves the agent with a `make check`
# that fails for reasons it cannot see. Each step says what it could not do, and
# the session starts either way.
warn() { echo "session-start: $* — 'make check' may fail until this is resolved" >&2; }

# `install` rather than `ci`: the container image is cached after this runs, so
# an unchanged lockfile costs nothing on the next session.
npm install --no-audit --no-fund || warn "npm install failed; ESLint is unavailable"

# gjs runs test/gjs/*.gjs.js; libglib2.0-bin provides glib-compile-schemas.
if ! command -v gjs >/dev/null || ! command -v glib-compile-schemas >/dev/null; then
	if apt-get update -qq && apt-get install -y --no-install-recommends gjs libglib2.0-bin; then
		:
	else
		warn "could not install gjs / libglib2.0-bin; 'make test' still works"
	fi
fi

exit 0
