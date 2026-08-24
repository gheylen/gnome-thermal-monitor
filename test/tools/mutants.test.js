// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// `tools/mutants.json` is the record of what the test suite is required to
// catch, and a mutant whose anchor no longer matches the source is a check that
// silently stopped checking — the failure mode this repository has been caught
// by more than once.
//
// `make mutate` already refuses a stale anchor, but only after running the whole
// suite once per mutant, which is minutes. Everything here is decidable by
// reading two files, so the gate can say it in milliseconds: an anchor that
// drifted while someone renamed a variable is found by `make check`, not by
// whoever next has time for the long run.

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {test} from 'node:test';

const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');

/** @type {import('../../tools/mutate.mjs').Mutant[]} */
const mutants = JSON.parse(readFileSync(join(root, 'tools/mutants.json'), 'utf8'));

const sourceOf = new Map();
const read = file => {
    if (!sourceOf.has(file)) sourceOf.set(file, readFileSync(join(root, file), 'utf8'));
    return sourceOf.get(file);
};

test('there are mutants at all', () => {
    // A file that quietly became an empty list would make every check below
    // vacuous, which is the shape of failure this whole file exists to refuse.
    assert.ok(Array.isArray(mutants) && mutants.length > 50,
        `found ${Array.isArray(mutants) ? mutants.length : typeof mutants}`);
});

test('every mutant is shaped like one', () => {
    for (const [index, mutant] of mutants.entries()) {
        const where = `mutant ${index}: ${mutant.describes ?? '(no description)'}`;
        for (const field of ['file', 'from', 'describes'])
            assert.equal(typeof mutant[field], 'string', `${where} — ${field} must be a string`);
        assert.equal(typeof mutant.to, 'string', `${where} — to must be a string ('' deletes)`);
        assert.notEqual(mutant.from, '', `${where} — an empty anchor matches everywhere`);
        assert.notEqual(mutant.from, mutant.to, `${where} — replacing text with itself tests nothing`);
        assert.deepEqual(Object.keys(mutant).filter(key =>
            !['file', 'from', 'to', 'describes', 'suite'].includes(key)), [],
        `${where} — unknown field, which the runner would ignore`);
    }
});

test('every mutant names a file that exists', () => {
    for (const mutant of mutants)
        assert.ok(existsSync(join(root, mutant.file)),
            `${mutant.describes} — no such file: ${mutant.file}`);
});

// The check that earns this file its place: `make mutate` finds these too, but
// only after several minutes, and only when somebody runs it.
test('every anchor is still present in its file', () => {
    const stale = mutants
        .filter(mutant => !read(mutant.file).includes(mutant.from))
        .map(mutant => `${mutant.describes} (${mutant.file})`);
    assert.deepEqual(stale, [],
        `re-anchor these on the code as it is now:\n  ${stale.join('\n  ')}`);
});

test('two mutants never share a description', () => {
    // The run reports survivors and stale anchors by description alone, so a
    // duplicate would name two different defects with one sentence.
    const seen = new Set();
    const duplicated = mutants.map(m => m.describes).filter(d => !seen.add(d));
    assert.deepEqual(duplicated, []);
});

test('a mutant is answered by a runtime that can load the file', () => {
    // Node cannot import `src/sysfs/gio.js` at all — it starts with `gi://Gio`.
    // A mutant aimed there and left on the default suite would be run against
    // tests that never see the change, and this project has already shipped one
    // guard that reported success because the thing it checked never ran.
    for (const mutant of mutants) {
        const needsGjs = mutant.file === 'src/sysfs/gio.js';
        assert.equal(mutant.suite ?? 'node', needsGjs ? 'gjs' : 'node',
            `${mutant.describes} — ${mutant.file} must be answered by ${needsGjs ? 'gjs' : 'node'}`);
    }
});
