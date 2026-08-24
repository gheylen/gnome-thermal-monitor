// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// A minimal test harness for the two files that run under `gjs`.
//
// Node's test runner is not available here, and pulling one in would mean
// shipping a dependency into the only place this project runs real GJS — the
// point of which is to be as close to the shell as possible. Twenty lines of
// TAP-ish output is enough, and both files used to carry their own copy of it,
// which had already drifted into two spellings of the same assertion.

import System from 'system';

let failures = 0;

/**
 * `System.version` is packed as major * 10000 + minor * 100 + micro.
 *
 * @returns {string} e.g. '1.80.2'
 */
function gjsVersion() {
    const packed = System.version;
    return `${Math.floor(packed / 10000)}.${Math.floor((packed % 10000) / 100)}.${packed % 100}`;
}

/**
 * The GJS the extension's own floor ships: GNOME Shell 46 carries GJS 1.80, on
 * SpiderMonkey 115. (SpiderMonkey 128 did not arrive until GJS 1.81.2, in the 47
 * cycle, so 1.80 and the older 1.78 are the same engine for our purposes.)
 */
const FLOOR = 1_80_00;

/**
 * Where a packed `System.version` stands relative to the floor.
 *
 * Exported so it can be checked against versions this machine is not running:
 * the line it produces is the only thing that tells a reader whether a passing
 * report is evidence about the floor or about something newer, and a status
 * line that quietly says the wrong thing is worse than none.
 *
 * @param {number} version  Packed as major * 10000 + minor * 100 + micro.
 * @returns {string}
 */
export function standingAgainstFloor(version) {
    if (version < FLOOR) return 'below the floor';
    return version < FLOOR + 100 ? 'the floor itself' : 'ahead of the floor';
}

/**
 * Say which engine this ran on, before anything else — and whether that engine
 * is the one the floor names.
 *
 * A pass is evidence about *this* GJS, not about the oldest one the extension
 * claims, and a report that does not say which invites the reader to assume
 * otherwise. So the line says it, and says it from `System.version` rather than
 * from prose that could go stale: a runner that happens to carry exactly the
 * floor is real evidence about the floor, and one that is ahead of it is not.
 * `eslint.config.js` is what holds shipped code to 115 either way.
 *
 * @param {string} suite
 */
export function announce(suite) {
    const standing = standingAgainstFloor(System.version);
    print(`# ${suite} on gjs ${gjsVersion()} — ${standing} (1.80, SpiderMonkey 115)`);
}

/**
 * @param {string} name
 * @param {boolean} condition
 * @param {string} [detail]
 */
export function check(name, condition, detail = '') {
    if (condition) {
        print(`ok - ${name}`);
    } else {
        failures++;
        print(`not ok - ${name}${detail ? ` (${detail})` : ''}`);
    }
}

const describe = (actual, expected) =>
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;

/**
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 */
export const equal = (name, actual, expected) =>
    check(name, actual === expected, describe(actual, expected));

/**
 * Structural comparison, by serialisation. Enough for the plain data these
 * suites deal in, and it keeps the harness to one screen.
 *
 * @param {string} name
 * @param {unknown} actual
 * @param {unknown} expected
 */
export const deepEqual = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected), describe(actual, expected));

/**
 * Report and exit. Called last by each suite, so a failure is a non-zero status
 * that `make test-gjs` propagates.
 *
 * @param {string} suite
 */
export function finish(suite) {
    print(failures === 0
        ? `# all ${suite} checks passed`
        : `# ${failures} ${suite} check(s) failed`);
    if (failures > 0) System.exit(1);
}
