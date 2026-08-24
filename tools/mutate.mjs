// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Mutation testing: break the code on purpose, one edit at a time, and require
// the suite to notice.
//
// A green test run says the tests agree with the code. It does not say the
// tests would still be green if the code were wrong, and that is the property
// worth having — this project's whole claim is that it does not overstate what
// the hardware said, and a rule nothing would catch changing is a rule nobody
// is checking.
//
// `tools/mutants.json` is the record: one entry per deliberate defect, each
// naming the exact source text to replace and what the resulting behaviour
// would be. They are hand-written rather than generated, because the
// interesting mutants are semantic — a counter read at the wrong edge, a
// sibling compared against the wrong history, an idle skip that no longer
// skips — and an operator-flipping generator does not produce those.
//
// A mutant that SURVIVES is a gap in the test suite. A mutant whose anchor is
// no longer in the source is worse: it is a check that silently stopped
// checking, so it fails the run rather than being reported and forgotten.
//
// Mutants are independent, so they run one per core, each in its own copy of the
// tree — a mutant edits a file in place, and two sharing a workspace would read
// each other's defects.
//
// Usage: node tools/mutate.mjs [--filter <substring>]
//        make mutate

import {spawn} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {availableParallelism, tmpdir} from 'node:os';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

/**
 * @typedef {object} Mutant
 * @property {string} file       Repository-relative path to edit.
 * @property {string} from       Exact source text to replace, once.
 * @property {string} to         What to replace it with. Empty deletes.
 * @property {string} describes  The defect, as a sentence.
 * @property {'node'|'gjs'} [suite]  Which runtime must catch it. Defaults to node.
 */

/**
 * Copy the whole tree, minus what must not be copied.
 *
 * Naming the directories to include instead was the first attempt, and it was
 * wrong: `test/release.test.js` reads `metadata.json`, `CHANGELOG.md` and the
 * `Makefile`, none of which were on the list, so the suite failed in the
 * workspace for a reason that had nothing to do with any mutant — and every
 * mutant was therefore reported killed. A mutation runner that reports a clean
 * sweep because the tests never ran is worse than no runner at all, which is
 * what the baseline check below exists to prevent from ever being true again.
 */
const EXCLUDED = new Set(['node_modules', '.git', 'dist']);

/**
 * Run one command to completion, discarding its output.
 *
 * `spawn` with `stdio: 'ignore'` rather than a buffering `execFile`: the Node
 * suite prints several hundred kilobytes of TAP, which would exceed
 * `maxBuffer` and fail for a reason that has nothing to do with any mutant —
 * exactly the class of false result this runner exists to avoid.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<void>} Rejects on a non-zero exit or a missing command.
 */
const run = (command, args, cwd) => new Promise((resolve_, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'ignore'});
    child.on('error', reject);
    child.on('close', code =>
        code === 0 ? resolve_() : reject(new Error(`${command} exited ${code}`)));
});

/**
 * Run a suite in `workspace`.  Rejects if it fails, which is the whole signal.
 *
 * Two suites, because there are two runtimes. `src/sysfs/gio.js` is the module
 * with the most runtime risk in the whole tree — it is the only one that touches
 * the filesystem — and Node cannot load it at all, so a mutant aimed at it has
 * to be answered by `gjs`. Leaving it uncovered meant the suite that provides
 * the *only* evidence about the shipped adapter had never been asked to prove it
 * would notice anything.
 *
 * Not exported: it is `apply()`'s default, and `apply()` takes it as a parameter
 * so the cases in `test/tools/mutate.test.js` can drive it with a fake instead
 * of running a suite each. This runner is itself a guard, and a guard nobody has
 * watched fail is not known to work — its first draft reported every mutant
 * killed because the tests never ran.
 *
 * @param {string} workspace
 * @param {'node'|'gjs'} [suite]
 * @returns {Promise<void>}
 */
async function runSuite(workspace, suite = 'node') {
    if (suite === 'gjs') {
        for (const file of GJS_SUITES)
            await run('gjs', ['-m', file], workspace);
        return;
    }
    await run(process.execPath, ['--test', 'test/**/*.test.js'], workspace);
}

/**
 * The GJS suites a mutant can be answered by.
 *
 * `npm run test:gjs` globs `test/gjs/*.gjs.js`, which is these two *and*
 * `smoke.gjs.js`. Smoke is deliberately absent: it substitutes nothing and
 * reads whatever `/sys` the machine running it has, so what it asserts depends
 * on the hardware rather than on the mutant. A mutation runner whose verdicts
 * moved with the machine would be worse than none.
 */
const GJS_SUITES = ['test/gjs/sysfs-gio.gjs.js', 'test/gjs/stack.gjs.js'];

/**
 * Apply one mutant, run the suite, and put the file back.
 *
 * The restore is in a `finally` because everything else here is best-effort but
 * that is not: leaving a mutated source behind would corrupt the workspace for
 * every mutant after it, and the failure would look like a code defect.
 *
 * @param {string} workspace
 * @param {Mutant} mutant
 * @param {(workspace: string, suite: 'node'|'gjs') => void|Promise<void>} [runTests]
 * @returns {Promise<'killed'|'survived'>}
 * @throws {Error} If the anchor text is not present — a stale mutant.
 */
export async function apply(workspace, mutant, runTests = runSuite) {
    const path = join(workspace, mutant.file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(mutant.from))
        throw new Error(`anchor not found in ${mutant.file}: ${mutant.describes}`);

    writeFileSync(path, original.replace(mutant.from, mutant.to));
    try {
        await runTests(workspace, mutant.suite ?? 'node');
        return 'survived';
    } catch {
        return 'killed';
    } finally {
        writeFileSync(path, original);
    }
}

/**
 * The command-line program.  Kept behind a check so that importing this module
 * — which a test must do to exercise `apply()` — does not start a mutation run.
 *
 * @returns {Promise<number>} Process exit code.
 */
/**
 * A copy of the tree a mutant can be applied to without disturbing any other.
 *
 * `node_modules` is symlinked rather than copied: it is by far the largest
 * thing here and nothing mutates it.
 *
 * @returns {string}
 */
function makeWorkspace() {
    const workspace = mkdtempSync(join(tmpdir(), 'ttm-mutate-'));
    process.on('exit', () => rmSync(workspace, {recursive: true, force: true}));
    cpSync(root, workspace, {
        recursive: true,
        filter: source => !EXCLUDED.has(relative(root, source).split(sep)[0]),
    });
    symlinkSync(join(root, 'node_modules'), join(workspace, 'node_modules'));
    return workspace;
}

async function main() {
    const filterIndex = process.argv.indexOf('--filter');
    const filter = filterIndex === -1 ? null : process.argv[filterIndex + 1];

    /** @type {Mutant[]} */
    const all = JSON.parse(readFileSync(join(root, 'tools/mutants.json'), 'utf8'));
    const mutants = filter
        ? all.filter(mutant => mutant.describes.toLowerCase().includes(filter.toLowerCase()))
        : all;

    if (mutants.length === 0) {
        console.error(filter ? `no mutant matches "${filter}"` : 'tools/mutants.json is empty');
        return 1;
    }

    // One workspace per worker, because a mutant edits a file in place: two
    // sharing a tree would read each other's defects. The tree is under a
    // megabyte with `node_modules` symlinked, so the copies are cheap and the
    // suite is what the wall clock is actually spent on.
    const workers = Math.max(1, Math.min(availableParallelism(), mutants.length));
    const workspaces = Array.from({length: workers}, makeWorkspace);

    // The one result that would invalidate every other: if a suite does not pass
    // on the unmutated copy, "killed" means nothing for its mutants, because
    // everything is killed. That includes `gjs` being absent — spawn would emit
    // ENOENT and every GJS mutant would read as caught by a suite that never
    // ran, which is precisely the failure this check exists for.
    for (const suite of new Set(mutants.map(mutant => mutant.suite ?? 'node'))) {
        try {
            await runSuite(workspaces[0], suite);
        } catch {
            console.error(`the ${suite} suite does not pass on an unmutated copy of the tree`);
            console.error(`every ${suite} mutant would read as killed; fix that first`);
            return 1;
        }
    }

    // Workers pull from one iterator, so a slow mutant does not leave a worker
    // idle behind a fixed slice. Results are stored by index and reported in
    // that order: which worker happened to take a mutant is not something a
    // report should vary by.
    /** @type {({outcome: 'survived'|'stale', description: string}|null)[]} */
    const results = new Array(mutants.length).fill(null);
    const queue = mutants.entries();
    let done = 0;

    await Promise.all(workspaces.map(async workspace => {
        for (const [index, mutant] of queue) {
            try {
                if (await apply(workspace, mutant) === 'survived')
                    results[index] = {outcome: 'survived', description: mutant.describes};
            } catch (error) {
                results[index] =
                    {outcome: 'stale', description: `${mutant.describes} — ${error.message}`};
            }
            process.stderr.write(`\r${++done}/${mutants.length} `);
        }
    }));
    process.stderr.write('\r');

    const found = results.filter(Boolean);
    const survived = found.filter(r => r.outcome === 'survived').map(r => r.description);
    const stale = found.filter(r => r.outcome === 'stale').map(r => r.description);

    console.log(`killed ${mutants.length - found.length}/${mutants.length}`);
    for (const description of survived) console.log(`  SURVIVED  ${description}`);
    for (const description of stale) console.log(`  STALE     ${description}`);

    if (survived.length > 0)
        console.log('\nA surviving mutant is a gap: the suite accepts this code broken.');
    if (stale.length > 0)
        console.log('\nA stale mutant tests nothing. Re-anchor it on the code as it is now.');

    return survived.length + stale.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) process.exit(await main());
