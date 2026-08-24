// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The prose tells people — and agents — which commands to run. A command that
// does not exist is worse than no instruction: it is followed, it fails, and
// the failure looks like the repository is broken rather than the sentence.
//
// This is the same drift the README's popup example had, caught the same way:
// assert the documentation against the thing it describes rather than trusting
// that someone updated both.

import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {glob} from 'node:fs/promises';
import {basename} from 'node:path';
import {test} from 'node:test';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const makefile = read('Makefile');
const DOCS = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md',
    'docs/HARDWARE-CHECK.md', 'BACKLOG.md', 'SECURITY.md',
    '.github/pull_request_template.md'];

/**
 * Names the worked example in the README invents on purpose. A contributor is
 * told to create these; they are the one kind of path that should not exist.
 */
const PLACEHOLDERS = new Set(['src/domain/mine.js', 'src/hardware/mine.js']);

/**
 * The lines inside ``` fences, where a command is a command rather than prose.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function fencedLines(markdown) {
    const lines = [];
    let inside = false;
    for (const line of markdown.split('\n')) {
        if (line.startsWith('```')) {
            inside = !inside;
            continue;
        }
        if (inside) lines.push(line);
    }
    return lines;
}

/** Targets the Makefile actually defines, from its rule lines. */
const defined = new Set(
    [...makefile.matchAll(/^([a-z][\w-]*):/gm)].map(match => match[1]));

/** Targets a `## name  description` line documents, which `make help` prints. */
const documented = new Set(
    [...makefile.matchAll(/^## (\S+)/gm)].map(match => match[1]));

test('the Makefile defines targets at all', () => {
    // A regex that matches nothing enforces nothing.
    assert.ok(defined.size > 5, `found only: ${[...defined].join(', ')}`);
});

test('every target `make help` advertises really exists', () => {
    const missing = [...documented].filter(target => !defined.has(target));
    assert.deepEqual(missing, [], `## comments name absent targets: ${missing.join(', ')}`);
});

test('every target the documentation tells you to run really exists', () => {
    for (const doc of DOCS) {
        const text = read(doc);
        const referenced = new Set([
            // Backticks anywhere, and a line-start `make x` only inside a fenced
            // code block. Outside one, prose wraps: "it does not make network
            // requests" and "add the cases that make it say no" both put a bare
            // `make` where a command would be, and neither is an instruction.
            ...[...text.matchAll(/`make ([a-z][\w-]*)/g)].map(match => match[1]),
            ...fencedLines(text)
                .map(line => line.match(/^make ([a-z][\w-]*)/)?.[1])
                .filter(Boolean),
        ]);
        const missing = [...referenced].filter(target => !defined.has(target));
        assert.deepEqual(missing, [], `${doc} tells you to run: ${missing.join(', ')}`);
    }
});

// The prose says what CI runs. This says the same thing from the other side: a
// `make` step a workflow invokes must be a target that exists. A typo there
// fails every pull request at once — or, in the release workflow, is discovered
// while cutting a release — and a workflow is the one kind of file no local
// command runs.
test('every make target a workflow invokes really exists', async () => {
    const invoked = new Map();
    for await (const file of glob('.github/workflows/*.yml',
        {cwd: new URL('..', import.meta.url).pathname})) {
        for (const [, target] of read(file).matchAll(/^\s*- run: make ([a-z][\w-]*)/gm))
            invoked.set(target, file);
    }
    assert.ok(invoked.size > 0, 'the workflows still drive the build through make');
    const missing = [...invoked].filter(([target]) => !defined.has(target));
    assert.deepEqual(missing, [],
        `absent targets: ${missing.map(([t, f]) => `${t} (${f})`).join(', ')}`);
});

// The pull-request template's checklist is the last thing a contributor reads
// before opening one, and CONTRIBUTING.md tells them to run `make check`. A
// checklist naming a weaker set invites a pull request that fails CI.
test('the pull-request checklist asks for the gate itself', () => {
    const template = read('.github/pull_request_template.md');
    assert.match(template, /`make check`/,
        'the checklist should ask for the gate, not for pieces of it');
});

test('the README lists the whole gate', () => {
    // `check`'s prerequisites are what a contributor is promised CI runs. The
    // README spells them out, and that sentence has gone stale before.
    const prerequisites = makefile.match(/^check: (.+)$/m)[1].trim().split(/\s+/);
    const readme = read('README.md');
    const sentence = readme.match(/^make check\s+# everything CI runs: (.+)$/m)?.[1];
    assert.ok(sentence, 'the README still describes `make check`');
    for (const target of prerequisites)
        assert.ok(sentence.includes(target),
            `\`make check\` runs ${target}; the README's summary omits it: "${sentence}"`);
});

test('every repository file the documentation points at exists', async () => {
    // A stale path is a dead end for anyone — human or agent — following the
    // prose to the code. Matched only inside backticks, so a sentence that
    // happens to contain a filename is not mistaken for a reference.
    const inRepo = new Set();
    for await (const path of glob('**/*.{js,mjs,json,md,css,xml,sh,yml,yaml}',
        {cwd: new URL('..', import.meta.url).pathname,
            exclude: name => name === 'node_modules' || name === 'dist'})) {
        inRepo.add(path);
        inRepo.add(basename(path));
    }
    assert.ok(inRepo.size > 20, 'the glob still finds the repository');

    const pattern = /`([A-Za-z0-9_./-]+\.(?:js|mjs|json|md|css|xml|sh|yml|yaml))`/g;
    for (const doc of DOCS) {
        const referenced = [...readFileSync(new URL(`../${doc}`, import.meta.url), 'utf8')
            .matchAll(pattern)].map(match => match[1]);
        const broken = [...new Set(referenced)].filter(path =>
            // A token whose basename starts with a dot is a suffix being
            // discussed, not a file: "the `.gjs.js` suffix". A dot-directory
            // like `.github/workflows/ci.yml` still has a real basename.
            !basename(path).startsWith('.') &&
            !PLACEHOLDERS.has(path) && !inRepo.has(path) && !existsSync(path));
        assert.deepEqual(broken, [], `${doc} points at: ${broken.join(', ')}`);
    }
});

test('the placeholder allowlist stays a list of things that do not exist', () => {
    // If someone ever adds a real src/hardware/mine.js, this entry stops being
    // a placeholder and starts hiding a path the check should be verifying.
    for (const path of PLACEHOLDERS)
        assert.equal(existsSync(path), false, `${path} exists; drop it from PLACEHOLDERS`);
});
