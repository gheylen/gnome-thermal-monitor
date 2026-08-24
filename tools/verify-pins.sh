#!/bin/sh
# SPDX-FileCopyrightText: 2026 G Heylen
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Check that every SHA-pinned GitHub Action in .github/workflows/ resolves
# upstream, and that the version comment beside it names a tag that really
# points at that commit.
#
# This is a public repository: a pin that points at nothing fails CI for
# everyone who opens a pull request, and the comment is the only thing a reader
# can check it against.
#
# `--offline` stops before the upstream lookup, checking only what can be known
# from the file: that every `uses:` names a 40-character commit SHA and carries
# a version comment. That half is what `make check` runs, so an action added by
# hand without a pin fails the gate rather than waiting for someone to remember
# `make verify-pins`. The lookup itself still needs network.
#
# Usage: tools/verify-pins.sh [--offline] [workflow-dir]

set -eu

offline=0
if [ "${1:-}" = "--offline" ]; then
	offline=1
	shift
fi

dir="${1:-.github/workflows}"
failed=0

# `while read` runs in a subshell, so failures are recorded in a file the parent
# can see afterwards.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# EVERY `uses:` line, however it is written. Matching only 40-hex pins would
# make an action that stopped being pinned invisible to the check that exists to
# say it is pinned — the same "matches nothing, enforces nothing" shape this
# project has already been caught by twice.
uses=$(grep -rhoE 'uses:[[:space:]]*[^[:space:]]+([[:space:]]*#[[:space:]]*[^[:space:]]+)?' \
	"$dir" | sort -u)

# A check that silently matches nothing enforces nothing. If the workflows are
# reformatted or moved out from under this pattern, that is a failure, not a pass.
if [ -z "$uses" ]; then
	echo "  found no actions under $dir — has the workflow format changed?"
	exit 1
fi

echo "$uses" | while IFS= read -r line; do
	# YAML allows the value to be quoted; strip the quotes before anything else.
	spec=$(printf '%s' "$line" \
		| sed -E 's/^uses:[[:space:]]*//; s/[[:space:]]*#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')
	tag=$(printf '%s' "$line" | sed -nE 's/.*#[[:space:]]*([^[:space:]]+).*/\1/p')

	# An action inside this repository is versioned by this repository.
	case $spec in ./*|docker://*) echo "  local       $spec"; continue;; esac

	action=${spec%@*}
	sha=${spec#*@}
	repo=$(printf '%s' "$action" | cut -d/ -f1,2)

	# A mutable ref — a tag or a branch — is the thing this check exists to
	# refuse. Whoever controls it can change what runs in CI after review.
	case $sha in
		*[!0-9a-f]*|"" )
			echo "  UNPINNED    $spec — pin it to a 40-character commit SHA"
			echo fail >>"$TMP"
			continue;;
	esac
	if [ ${#sha} -ne 40 ]; then
		echo "  UNPINNED    $spec — pin it to a 40-character commit SHA"
		echo fail >>"$TMP"
		continue
	fi

	if [ -z "$tag" ]; then
		echo "  UNLABELLED  $action@$sha — pin it with a '# vX.Y.Z' comment"
		echo fail >>"$TMP"
		continue
	fi

	if [ "$offline" -eq 1 ]; then
		echo "  pinned      $repo@$tag (not resolved — offline)"
		continue
	fi

	# Exact refs only: a substring match would let '# v7' pass for the commit
	# tagged v7.0.1, which is the kind of near-truth this check exists to catch.
	if git ls-remote "https://github.com/$repo" \
		"refs/tags/$tag" "refs/tags/$tag^{}" 2>/dev/null \
		| awk -v s="$sha" '$1 == s { found = 1 } END { exit !found }'; then
		echo "  ok          $repo@$tag"
	else
		actual=$(git ls-remote "https://github.com/$repo" 2>/dev/null \
			| awk -v s="$sha" '$1 == s { printf "%s ", $2 }')
		echo "  BAD         $repo@$tag — ${actual:-no ref upstream points at $sha}"
		echo fail >>"$TMP"
	fi
done

[ -s "$TMP" ] && failed=1
exit "$failed"
