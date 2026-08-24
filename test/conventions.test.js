// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// `.editorconfig` declares how every file in this repository is written. An
// editor that reads it keeps to it; nothing else did, and a file written by a
// script — or by an agent — is written by neither.
//
// The three rules here are the ones from its `[*]` section that hold for every
// file regardless of language, and each has a concrete cost. A missing final
// newline makes the next change to that file show as two lines in a diff rather
// than one. A CRLF in a shipped `.js` reaches SpiderMonkey. Trailing whitespace
// is invisible until it turns up in a review.
//
// `tools/mutants.json` was found without its final newline, having been edited
// by a script often enough that nobody's editor ever opened it.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {glob, lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';

const root = new URL('..', import.meta.url).pathname;

/**
 * Build output, which nobody writes and `make clean` removes. `dist/` and
 * `node_modules/` are directories the sweep never descends into;
 * `gschemas.compiled` is a binary that `make schema` leaves beside its source,
 * and it is present in a working tree that has run the gate — including the
 * copy `make mutate` takes, where a file this could not read would fail the
 * suite for every mutant and report the lot as killed.
 */
const NOT_OURS = new Set(['node_modules', 'dist', '.git']);
const GENERATED = new Set(['schemas/gschemas.compiled']);

/**
 * Every regular file in the repository that somebody wrote.
 *
 * Symlinks are skipped: `CLAUDE.md` points at `AGENTS.md`, and reading it would
 * hold one file to these rules twice while claiming to check two.
 *
 * @returns {Promise<string[]>}
 */
async function authoredFiles() {
    const found = [];
    for await (const path of glob('**/*', {cwd: root, exclude: name => NOT_OURS.has(name)})) {
        if (GENERATED.has(path)) continue;
        const stats = await lstat(join(root, path));
        if (stats.isFile()) found.push(path);
    }
    return found.sort();
}

const files = await authoredFiles();

test('the sweep still finds the repository', () => {
    // A glob that stopped matching would make every check below vacuous.
    assert.ok(files.length > 50, `found ${files.length} files`);
});

test('every file ends with a newline', async () => {
    const offenders = files.filter(path => {
        const text = readFileSync(join(root, path), 'utf8');
        return text !== '' && !text.endsWith('\n');
    });
    assert.deepEqual(offenders, []);
});

test('no file uses CRLF line endings', async () => {
    const offenders = files.filter(path =>
        readFileSync(join(root, path), 'utf8').includes('\r'));
    assert.deepEqual(offenders, []);
});

test('no line carries trailing whitespace, outside Markdown', async () => {
    // `.editorconfig` exempts `.md`, where two trailing spaces are a line break.
    const offenders = [];
    for (const path of files.filter(name => !name.endsWith('.md'))) {
        const lines = readFileSync(join(root, path), 'utf8').split('\n');
        const at = lines.findIndex(line => /[ \t]$/.test(line));
        if (at !== -1) offenders.push(`${path}:${at + 1}`);
    }
    assert.deepEqual(offenders, []);
});
