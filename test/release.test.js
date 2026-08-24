// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The release workflow refuses a tag whose version does not appear in the
// changelog, or whose heading still says "unreleased". That gate fires exactly
// once, at the moment a mistake is most expensive to correct: a published
// extensions.gnome.org version cannot be taken back.
//
// The half of it that is true on every commit — the declared version must have
// a changelog entry — is asserted here instead, so a bump without a note fails
// the pull request that introduced it rather than the release six weeks later.
//
// "unreleased" is deliberately not checked here: on `main` that is the correct
// state, and only tagging makes it wrong.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const metadata = JSON.parse(read('metadata.json'));
const changelog = read('CHANGELOG.md');

/** Every `## [N]` heading, newest first, as the workflow's grep sees them. */
const headings = changelog.split('\n').filter(line => /^## \[\d+\]/.test(line));

// The integer version itself, and the settings-schema id, are schema.test.js's
// to assert — they are facts about the manifest, not about releasing.

test('package.json carries no version to disagree with it', () => {
    // One source of truth. A second one is a second thing to forget to bump.
    assert.equal(JSON.parse(read('package.json')).version, undefined);
});

test('the declared version has a changelog heading', () => {
    const wanted = `## [${metadata.version}]`;
    assert.ok(headings.some(heading => heading.startsWith(wanted)),
        `CHANGELOG.md needs a "${wanted}" heading; it has: ${headings.join(', ')}`);
});

test('the changelog versions descend, with no gaps or repeats', () => {
    const versions = headings.map(heading => Number(heading.match(/^## \[(\d+)\]/)[1]));
    assert.deepEqual(versions, [...new Set(versions)], 'a version is documented once');
    assert.deepEqual(versions, [...versions].sort((a, b) => b - a), 'newest first');
    assert.equal(versions[0], metadata.version,
        'the newest heading is the version being shipped');
});

test('the shell versions are a list of integer-like strings', () => {
    // extensions.gnome.org rejects a manifest whose shell-version holds a
    // number rather than a string, and it is not a mistake anything else here
    // would notice.
    assert.ok(Array.isArray(metadata['shell-version']) && metadata['shell-version'].length > 0);
    for (const version of metadata['shell-version']) {
        assert.equal(typeof version, 'string', `shell-version ${version} must be a string`);
        assert.match(version, /^\d+(\.\d+)?$/);
    }
});

test('the uuid is the one the Makefile packages and installs under', () => {
    // The Makefile hard-codes the UUID for the zip name and the install
    // symlink. GNOME Shell loads an extension by the directory name matching
    // metadata.json's uuid, so a drift installs an extension the shell ignores.
    const declared = read('Makefile').match(/^UUID\s*:=\s*(\S+)/m)?.[1];
    assert.equal(declared, metadata.uuid);
});

test('no session-modes are declared, so the extension stops at the lock screen', () => {
    // Absent means GNOME Shell applies the default ["user"], and disables the
    // extension when the session mode becomes "unlock-dialog" — which runs
    // disable(), destroys the indicator and clears both timers. Declaring
    // "unlock-dialog" here would keep the poll timer running behind a lock
    // screen, for a panel that is not on screen. See BACKLOG.md.
    assert.equal(metadata['session-modes'], undefined);
});
