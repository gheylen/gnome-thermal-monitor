// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// `tools/check-package.mjs` proves every module the entry points import is in
// the shipped archive. This is the other half of that claim: every module in
// the archive is exercised by a test.
//
// It found src/log.js, which had shipped in every release with no test at all —
// not because anyone decided it did not need one, but because nothing asked.
// A module that nothing imports from test/ is a module whose behaviour is
// whatever it happens to be.
//
// Imports are parsed rather than pattern-matched, with the same parser the
// package check uses, so a specifier inside a comment or a template literal
// cannot invent coverage that does not exist.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {glob} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {test} from 'node:test';

import {isRuntimeSpecifier, parseImports} from '../tools/check-package.mjs';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** @param {string} pattern @returns {Promise<string[]>} repo-relative paths */
async function files(pattern) {
    const found = [];
    for await (const path of glob(pattern, {cwd: root})) found.push(path);
    return found.sort();
}

/** Every src/ module some test file imports, directly or through another test. */
async function importedByTests() {
    const reached = new Set();
    for (const testFile of [...await files('test/**/*.test.js'), ...await files('test/**/*.gjs.js')]) {
        const absolute = join(root, testFile);
        for (const specifier of parseImports(readFileSync(absolute, 'utf8'))) {
            if (isRuntimeSpecifier(specifier) || !specifier.startsWith('.')) continue;
            reached.add(relative(root, resolve(dirname(absolute), specifier)));
        }
    }
    return reached;
}

test('every shipped module is imported by a test', async () => {
    const shipped = await files('src/**/*.js');
    assert.ok(shipped.length > 0, 'the glob still finds the source tree');

    const tested = await importedByTests();
    const untested = shipped.filter(module => !tested.has(module));
    assert.deepEqual(untested, [],
        `no test imports these: ${untested.join(', ')}`);
});

test('the test suite imports nothing from src/ that is not shipped', async () => {
    // The mirror image: a test reaching for a module the Makefile does not
    // package would be testing something users never receive.
    const shipped = new Set(await files('src/**/*.js'));
    const strays = [...await importedByTests()]
        .filter(module => module.startsWith('src/') && !shipped.has(module));
    assert.deepEqual(strays, []);
});

test('every build-time tool is exercised by a test too', async () => {
    // These are guards: they decide whether a package is sound and whether the
    // tests are worth anything. A guard nobody has watched fail is not known to
    // work, and two of the three here were found unable to fail once someone
    // looked. Shell scripts are spawned rather than imported, so they are
    // checked by name.
    const tested = await importedByTests();
    const suite = (await files('test/**/*.test.js'))
        .map(path => readFileSync(join(root, path), 'utf8'))
        .join('\n');

    // Everything under tools/, not `*.mjs` and `*.sh`: a pattern that names the
    // extensions in use today would stop covering the moment somebody adds a
    // tool with a different one, and would do it silently. A module has to be
    // imported; anything else — a script, or the mutant record — has to be
    // named, which is how a test reaches something it cannot import.
    const uncovered = (await files('tools/*'))
        .filter(tool => !tested.has(tool) && !suite.includes(tool));
    assert.deepEqual(uncovered, [], `nothing exercises: ${uncovered.join(', ')}`);
});

test('nothing is exported that only its own module uses', async () => {
    // A build tool's exports are its interface, and one with no caller is
    // surface nobody is holding to anything — `tools/mutate.mjs` exported its
    // suite runner for a while, which read as a supported entry point while
    // being the default value of a parameter.
    const paths = [...await files('src/**/*.js'), ...await files('tools/*.mjs')];
    const bodies = await Promise.all(
        [...paths, ...await files('test/**/*.js'), 'extension.js', 'prefs.js']
            .map(async path => [path, readFileSync(join(root, path), 'utf8')]));

    const orphans = [];
    for (const path of paths) {
        const source = readFileSync(join(root, path), 'utf8');
        for (const [, name] of source.matchAll(/^export (?:const|function|class|async function) (\w+)/gm)) {
            const elsewhere = bodies.some(([other, body]) =>
                other !== path && new RegExp(`\\b${name}\\b`).test(body));
            if (!elsewhere) orphans.push(`${path} → ${name}`);
        }
    }
    assert.deepEqual(orphans, []);
});

test('the entry points are covered where Node can reach them', async () => {
    // extension.js and prefs.js import GNOME Shell modules, so Node cannot load
    // them at all. test/gjs/stack.gjs.js parses both under the real engine —
    // the only automated statement this project can make about them.
    const stack = readFileSync(join(root, 'test/gjs/stack.gjs.js'), 'utf8');
    for (const entry of ['extension.js', 'prefs.js'])
        assert.match(stack, new RegExp(entry.replace('.', '\\.')),
            `test/gjs/stack.gjs.js should still exercise ${entry}`);
});
