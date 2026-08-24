// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The SessionStart hook runs before an agent's first command in a Claude Code on
// the web session, and its job is to make `make check` work from that first
// command. Two ways it can be wrong, both invisible until someone hits them:
// running on a developer's own machine, where installing system packages is not
// its business, and failing hard on a setup step, which aborts the session start
// and leaves the agent with a gate failing for reasons it cannot see.
//
// Neither is reachable from a normal test run, so both are asserted directly.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const HOOK = new URL('../.claude/hooks/session-start.sh', import.meta.url).pathname;
const source = readFileSync(HOOK, 'utf8');

test('the hook is valid shell', () => {
    const {status, stderr} = spawnSync('sh', ['-n', HOOK], {encoding: 'utf8'});
    assert.equal(status, 0, stderr);
});

test('it does nothing at all outside a remote session', () => {
    // A local checkout is a developer's machine: npm ci and apt-get are their
    // business, not a hook's.
    for (const CLAUDE_CODE_REMOTE of ['', 'false', '1', 'TRUE']) {
        const {status, stdout} = spawnSync('bash', [HOOK], {
            encoding: 'utf8',
            env: {...process.env, CLAUDE_CODE_REMOTE},
            timeout: 10_000,
        });
        assert.equal(status, 0, `for ${JSON.stringify(CLAUDE_CODE_REMOTE)}`);
        assert.equal(stdout.trim(), '', 'and says nothing');
    }
});

test('no setup step is allowed to abort the session', () => {
    // It ran under `set -e` once, so a network hiccup during npm install ended
    // the hook and the agent met a broken gate with no explanation. Each step
    // reports what it could not do and the session starts either way.
    assert.doesNotMatch(source, /^set -[a-z]*e/m,
        'errexit would make a transient failure fatal');
    for (const step of ['npm install', 'apt-get install'])
        assert.ok(source.includes(step), `the hook should still run ${step}`);
    assert.match(source, /\|\| warn |else\n\t*warn /,
        'every step that can fail should report rather than abort');
});

test('it is registered, and points at the file that exists', () => {
    const settings = JSON.parse(readFileSync(
        new URL('../.claude/settings.json', import.meta.url), 'utf8'));
    const commands = settings.hooks.SessionStart
        .flatMap(entry => entry.hooks)
        .map(hook => hook.command);
    assert.deepEqual(commands, ['$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh']);
});
