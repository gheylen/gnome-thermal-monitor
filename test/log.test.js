// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The diagnostics port. Small, but it is the only module allowed to write to
// the journal, and everything the extension ever says about itself goes through
// it — including the lines a bug report is asked to paste back.
//
// The prefix is the contract: README and CONTRIBUTING both tell users to run
// `journalctl … | grep ThermalThrottleMonitor`, and a message that does not
// carry it is invisible to the person trying to report the bug.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import * as log from '../src/log.js';

/** Run `body` with console.warn/error captured; returns the argument lists. */
function captured(body) {
    const calls = [];
    const {warn, error} = console;
    console.warn = (...args) => calls.push(['warn', ...args]);
    console.error = (...args) => calls.push(['error', ...args]);
    try {
        body();
    } finally {
        Object.assign(console, {warn, error});
    }
    return calls;
}

const PREFIX = '[ThermalThrottleMonitor]';

test('every line carries the prefix a bug report is told to grep for', () => {
    const calls = captured(() => {
        log.warn('no supported GPU found');
        log.error('Poll failed:', new Error('boom'));
    });
    for (const [, message] of calls)
        assert.ok(message.startsWith(`${PREFIX} `), `"${message}" is not prefixed`);
});

test('warnings and errors go to their own console channels', () => {
    const calls = captured(() => {
        log.warn('w');
        log.error('e', 'cause');
    });
    assert.deepEqual(calls.map(call => call[0]), ['warn', 'error']);
});

test('an error with a cause passes it through untouched', () => {
    const cause = new Error('boom');
    const [call] = captured(() => log.error('Poll failed:', cause));
    assert.deepEqual(call, ['error', `${PREFIX} Poll failed:`, cause]);
});

test('an error with no cause does not write the word "undefined"', () => {
    // `console.error(message, undefined)` formats both arguments, so every such
    // line arrived in the journal with a bare "undefined" stuck to the end of it.
    const [call] = captured(() => log.error('Failed to enable:'));
    assert.deepEqual(call, ['error', `${PREFIX} Failed to enable:`],
        'the absent cause is omitted, not logged');
});

test('a falsy cause is still a cause', () => {
    // null and 0 are things a caller can genuinely have; only undefined means
    // "there is nothing to report here".
    for (const cause of [null, 0, '', false]) {
        const [call] = captured(() => log.error('x:', cause));
        assert.equal(call.length, 3, `cause ${JSON.stringify(cause)} was dropped`);
        assert.equal(call[2], cause);
    }
});
