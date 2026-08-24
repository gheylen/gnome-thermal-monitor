// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// `make check` runs tools/verify-pins.sh --offline, and on the real workflows it
// always passes — so none of its refusals had ever fired. This is a public
// repository: a `uses:` pinned to a mutable tag lets whoever controls that tag
// change what runs in CI after review, and a pin with no version comment leaves
// a reader nothing to check it against. Both are what this script exists to
// refuse, and a refusal nobody has watched work is not known to work.
//
// The upstream half — resolving each SHA against its repository — needs network
// and is `make verify-pins`; only the offline half is exercised here.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const SCRIPT = new URL('../../tools/verify-pins.sh', import.meta.url).pathname;
const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

/** Run the offline check over a directory holding the given workflow files. */
function check(workflows) {
    const dir = mkdtempSync(join(tmpdir(), 'ttm-pins-'));
    try {
        mkdirSync(dir, {recursive: true});
        for (const [name, contents] of Object.entries(workflows))
            writeFileSync(join(dir, name), contents);
        const {status, stdout} = spawnSync('sh', [SCRIPT, '--offline', dir], {encoding: 'utf8'});
        return {status, stdout};
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
}

const workflow = uses => `jobs:\n  a:\n    steps:\n      - uses: ${uses}\n`;

test('a pinned, labelled action passes', () => {
    const {status, stdout} = check({'ci.yml': workflow(`actions/checkout@${SHA} # v7.0.1`)});
    assert.equal(status, 0, stdout);
    assert.match(stdout, /pinned\s+actions\/checkout@v7\.0\.1/);
});

test('quoting the value does not hide the pin', () => {
    const {status, stdout} = check({'ci.yml': workflow(`"actions/checkout@${SHA}" # v7.0.1`)});
    assert.equal(status, 0, stdout);
    const single = check({'ci.yml': workflow(`'actions/checkout@${SHA}' # v7.0.1`)});
    assert.equal(single.status, 0, single.stdout);
});

test('a mutable ref is refused', () => {
    // The whole point: whoever controls the tag can change what runs in CI.
    for (const ref of ['v4', 'main', 'refs/heads/main', `${SHA.slice(0, 7)}`]) {
        const {status, stdout} = check({'ci.yml': workflow(`actions/checkout@${ref}`)});
        assert.equal(status, 1, `${ref} should be refused: ${stdout}`);
        assert.match(stdout, /UNPINNED/);
    }
});

test('a pin with no version comment is refused', () => {
    const {status, stdout} = check({'ci.yml': workflow(`actions/checkout@${SHA}`)});
    assert.equal(status, 1, stdout);
    assert.match(stdout, /UNLABELLED/);
});

test('an action inside this repository is versioned by this repository', () => {
    const {status, stdout} = check({'ci.yml': workflow('./.github/actions/local')});
    assert.equal(status, 0, stdout);
    assert.match(stdout, /local/);
});

test('one bad pin among good ones still fails the run', () => {
    const {status, stdout} = check({
        'ci.yml': workflow(`actions/checkout@${SHA} # v7.0.1`),
        'release.yml': workflow('actions/checkout@v4'),
    });
    assert.equal(status, 1, stdout);
    assert.match(stdout, /UNPINNED/);
});

test('a directory with no actions in it fails rather than passing quietly', () => {
    // A check that silently matches nothing enforces nothing. If the workflows
    // are reformatted out from under the pattern, that is a failure, not a pass
    // — this repository has shipped a lint rule that matched nothing before.
    const {status, stdout} = check({'ci.yml': 'name: CI\non: push\n'});
    assert.equal(status, 1, stdout);
    assert.match(stdout, /found no actions/);
});
