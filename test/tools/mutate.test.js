// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The mutation runner is itself a guard, and this repository has already been
// caught by a guard that could not fail: its first draft copied only some of the
// tree into its workspace, so the suite failed there for reasons unrelated to
// any mutant and every mutant was reported killed. A clean sweep meant nothing.
//
// `apply()` takes the suite runner as an argument for exactly this reason —
// these cases drive it with a fake and assert what it concludes, and, just as
// importantly, that the source file is put back every time.

import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

import {apply} from '../../tools/mutate.mjs';

const SOURCE = 'export const RATIO = 0.95;\nexport const OTHER = 0.95;\n';

/** A workspace holding one file, and the mutant that edits it. */
function workspaceOf(contents = SOURCE) {
    const dir = mkdtempSync(join(tmpdir(), 'ttm-mut-'));
    writeFileSync(join(dir, 'rule.js'), contents);
    return {
        dir,
        read: () => readFileSync(join(dir, 'rule.js'), 'utf8'),
        cleanup: () => rmSync(dir, {recursive: true, force: true}),
    };
}

const mutant = (over = {}) =>
    ({file: 'rule.js', from: 'RATIO = 0.95', to: 'RATIO = 0.5', describes: 'ratio widened', ...over});

const passes = () => {};
const fails = () => { throw new Error('tests failed'); };

test('a mutant the suite catches is killed', async () => {
    const workspace = workspaceOf();
    try {
        assert.equal(await apply(workspace.dir, mutant(), fails), 'killed');
    } finally {
        workspace.cleanup();
    }
});

test('a mutant the suite does not catch survives', async () => {
    const workspace = workspaceOf();
    try {
        assert.equal(await apply(workspace.dir, mutant(), passes), 'survived');
    } finally {
        workspace.cleanup();
    }
});

test('a mutant whose anchor is gone is a stale mutant, not a survivor', async () => {
    // The difference matters: a survivor is a gap in the tests, a stale anchor
    // is a check that quietly stopped checking. Reporting the second as the
    // first would hide it among real findings.
    const workspace = workspaceOf();
    try {
        await assert.rejects(() => apply(workspace.dir, mutant({from: 'NOT PRESENT'}), fails),
            /anchor not found in rule\.js: ratio widened/);
    } finally {
        workspace.cleanup();
    }
});

test('the suite is not run at all for a stale mutant', async () => {
    const workspace = workspaceOf();
    let ran = false;
    try {
        await assert.rejects(() => apply(workspace.dir, mutant({from: 'NOT PRESENT'}),
            () => { ran = true; }));
        assert.equal(ran, false, 'nothing was mutated, so there is nothing to test');
    } finally {
        workspace.cleanup();
    }
});

test('the file is restored whatever the outcome', async () => {
    // Not best-effort: a mutated file left behind corrupts every mutant after
    // it, and the failure then looks like a defect in the code under test.
    for (const runTests of [passes, fails]) {
        const workspace = workspaceOf();
        try {
            await apply(workspace.dir, mutant(), runTests);
            assert.equal(workspace.read(), SOURCE);
        } finally {
            workspace.cleanup();
        }
    }
});

test('the file is restored even when the runner itself throws something odd', async () => {
    const workspace = workspaceOf();
    try {
        await apply(workspace.dir, mutant(), () => { throw 'not an Error'; });
        assert.equal(workspace.read(), SOURCE);
    } finally {
        workspace.cleanup();
    }
});

test('the suite sees the mutated source, not the original', async () => {
    const workspace = workspaceOf();
    let seen = null;
    try {
        await apply(workspace.dir, mutant(), () => { seen = workspace.read(); });
        assert.match(seen, /RATIO = 0\.5/);
        assert.doesNotMatch(seen, /RATIO = 0\.95/);
    } finally {
        workspace.cleanup();
    }
});

test('only the first occurrence is replaced', async () => {
    // Two identical constants are ordinary. Replacing both would test a defect
    // nobody would write, and could pass for reasons unrelated to the anchor.
    const workspace = workspaceOf();
    let seen = null;
    try {
        await apply(workspace.dir, mutant({from: '0.95', to: '0.5'}),
            () => { seen = workspace.read(); });
        assert.equal(seen, 'export const RATIO = 0.5;\nexport const OTHER = 0.95;\n');
    } finally {
        workspace.cleanup();
    }
});

test('a mutant names the runtime that must catch it', async () => {
    // src/sysfs/gio.js cannot be loaded by Node at all, so a mutant aimed at it
    // has to be answered by gjs. Passing the wrong suite would run tests that
    // cannot see the change and report every such mutant as surviving.
    const workspace = workspaceOf();
    const seen = [];
    try {
        await apply(workspace.dir, mutant(), (_dir, suite) => seen.push(suite));
        await apply(workspace.dir, mutant({suite: 'gjs'}), (_dir, suite) => seen.push(suite));
        assert.deepEqual(seen, ['node', 'gjs'], 'node is the default, gjs is asked for');
    } finally {
        workspace.cleanup();
    }
});

// The suites are child processes, so a real run is asynchronous and several
// mutants are in flight at once. A missing `await` would make every mutant with
// a slow failure read as surviving, and leave the file mutated for whichever
// worker took the next one — the same silent, sweeping wrongness this runner's
// first draft had.
test('an asynchronous suite is waited for, not merely started', async () => {
    const workspace = workspaceOf();
    const rejectsLater = async () => {
        await Promise.resolve();
        throw new Error('tests failed');
    };
    try {
        assert.equal(await apply(workspace.dir, mutant(), rejectsLater), 'killed');
        assert.equal(workspace.read(), SOURCE, 'and restored only after it settled');
    } finally {
        workspace.cleanup();
    }
});

test('an asynchronous suite that passes leaves a survivor', async () => {
    const workspace = workspaceOf();
    const resolvesLater = async () => { await Promise.resolve(); };
    try {
        assert.equal(await apply(workspace.dir, mutant(), resolvesLater), 'survived');
    } finally {
        workspace.cleanup();
    }
});

test('importing the runner does not start a mutation run', () => {
    // The module is a command-line program as well as a library. If the two
    // were not separated, this very file would have launched one on import.
    assert.equal(typeof apply, 'function');
});
