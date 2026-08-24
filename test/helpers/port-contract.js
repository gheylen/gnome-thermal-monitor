// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// One contract, two implementations.
//
// Every hardware test drives an in-memory fake, and the extension ships a Gio
// adapter. If those two disagree about what the Sysfs port does, the whole
// suite is describing a machine that does not exist — which is the mistake this
// repository has made before, and the one it is least able to notice: the tests
// stay green, because they are consistent with each other.
//
// So the cases live here, written against a tree both can build, and both are
// held to them: `test/sysfs/contract.test.js` runs them against
// `fakeSysfs` under Node, and `test/gjs/sysfs-gio.gjs.js` materialises the same
// tree on disk and runs them against `gioSysfs`.
//
// Anything a case cannot express in both — a file that is not valid UTF-8, for
// instance, which an in-memory map of strings cannot hold — stays in the GJS
// test as a case about the real adapter alone.

/** The tree, as paths relative to a root each implementation supplies. */
export const FILES = Object.freeze({
    'device/name': 'coretemp\n',
    'device/temp1_input': '55000\n',
    'device/temp1_crit': '100000',
    'device/blank': '',
    'device/text': 'not an integer\n',
    'device/hex': '0x10',
    'device/units': '1200 kHz',
    'device/negative': '-40\n',
    'device/padded': '  42  \n',
    'device/huge': '9'.repeat(30),
    // Natural ordering is a guarantee of the port, and the only place several
    // adapters index into a listing across polls.
    'cpu/cpu10/value': '10',
    'cpu/cpu2/value': '2',
    'cpu/cpu1/value': '1',
});

/** Symlinks, relative to the same root. Values are the link targets. */
export const LINKS = Object.freeze({'device/driver': '../drivers/xe'});

/**
 * Every case both implementations must answer identically.
 *
 * @param {string} root  Absolute path the tree above was built under.
 * @returns {{name: string, run: (sysfs: import('../../src/sysfs/port.js').Sysfs) => unknown,
 *            expected: unknown}[]}
 */
export function contractCases(root) {
    const at = relative => `${root}/${relative}`;
    const text = (name, relative, expected) =>
        ({name, run: sysfs => sysfs.readText(at(relative)), expected});
    const int = (name, relative, expected) =>
        ({name, run: sysfs => sysfs.readInt(at(relative)), expected});

    return [
        // ── readText ───────────────────────────────────────────────────────
        text('readText returns contents, trimmed', 'device/name', 'coretemp'),
        text('readText trims both ends', 'device/padded', '42'),
        text('readText on an empty file is an empty string, not null',
            'device/blank', ''),
        text('readText on a missing path is null', 'device/absent', null),
        text('readText on a directory is null rather than a throw', 'device', null),
        text('readText on the root itself is null', '', null),

        // ── readInt ────────────────────────────────────────────────────────
        int('readInt parses a sysfs integer', 'device/temp1_input', 55000),
        int('readInt parses a negative value', 'device/negative', -40),
        int('readInt ignores surrounding whitespace', 'device/padded', 42),
        int('readInt refuses text', 'device/text', null),
        int('readInt refuses hexadecimal', 'device/hex', null),
        int('readInt refuses a value with units', 'device/units', null),
        int('readInt refuses an empty file', 'device/blank', null),
        int('readInt refuses an unsafe magnitude', 'device/huge', null),
        int('readInt on a missing path is null', 'device/absent', null),
        int('readInt on a directory is null', 'device', null),

        // ── list ───────────────────────────────────────────────────────────
        {
            name: 'list returns entries in natural order',
            run: sysfs => sysfs.list(at('cpu')),
            expected: ['cpu1', 'cpu2', 'cpu10'],
        },
        {
            name: 'list returns directory names, not paths',
            run: sysfs => sysfs.list(at('cpu/cpu1')),
            expected: ['value'],
        },
        {
            name: 'list on a missing directory is empty',
            run: sysfs => sysfs.list(at('nowhere')),
            expected: [],
        },
        {
            name: 'list on a file is empty rather than a throw',
            run: sysfs => sysfs.list(at('device/name')),
            expected: [],
        },
        {
            name: 'list does not descend',
            run: sysfs => sysfs.list(at('.')).includes('cpu1'),
            expected: false,
        },

        // ── driverOf ───────────────────────────────────────────────────────
        {
            name: 'driverOf is the basename of the driver symlink',
            run: sysfs => sysfs.driverOf(at('device')),
            expected: 'xe',
        },
        {
            name: 'driverOf on a device with no driver is null',
            run: sysfs => sysfs.driverOf(at('cpu')),
            expected: null,
        },
        {
            name: 'driverOf on a missing device is null',
            run: sysfs => sysfs.driverOf(at('nowhere')),
            expected: null,
        },
        {
            name: 'driverOf does not follow the link to read a file',
            run: sysfs => sysfs.driverOf(at('device/name')),
            expected: null,
        },

        // ── The port object itself ─────────────────────────────────────────
        {name: 'the port is frozen', run: sysfs => Object.isFrozen(sysfs), expected: true},
        {
            name: 'the port offers exactly the four operations',
            run: sysfs => Object.keys(sysfs).sort().join(','),
            expected: 'driverOf,list,readInt,readText',
        },
    ];
}
