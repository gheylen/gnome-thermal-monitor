// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// In-memory Sysfs port for tests.
//
// The whole point of the Sysfs port is that hardware adapters can be driven
// without a kernel.  Describe a machine as a flat path → contents map and the
// adapters behave exactly as they would on the real thing.

import {makeSysfs} from '../../src/sysfs/port.js';

/**
 * @param {object} tree
 * @param {Record<string, string>} [tree.files]   Absolute path → file contents.
 * @param {Record<string, string>} [tree.links]   Absolute path → symlink target.
 * @param {string[]} [tree.unreadable]            Paths that exist but fail to read.
 * @param {(path: string) => void} [tree.onRead]   Called for every `readText`,
 *   present or not, and so for every `readInt`, which is built on it. Not for
 *   `list` or `driverOf`: those answer from the shape of the tree rather than
 *   from a file, and no claim in this suite is about them. Lets a test assert
 *   what an adapter did *not* touch — the only way to state a claim about reads
 *   that are expensive on real hardware, such as one that resumes a
 *   runtime-suspended GPU. A path → contents map has no side effects of its own,
 *   so without this the claim cannot be tested at all.
 * @returns {import('../../src/sysfs/port.js').Sysfs}
 */
export function fakeSysfs({files = {}, links = {}, unreadable = [], onRead} = {}) {
    // A fixture describes bytes on a disk, so every value is text. Caught here,
    // where the path is in hand, rather than as `.trim is not a function` three
    // frames inside an adapter — and caught rather than coerced, because a
    // number in a fixture is a fixture that has stopped describing a file.
    //
    // `filesIn` below does coerce, deliberately: writing `temp1_input: 55_000`
    // is how a described machine reads, and that helper is the one place where
    // the number is obviously being turned into the file's contents. A number
    // reaching this map directly has been through no such step.
    for (const [path, contents] of Object.entries(files))
        if (typeof contents !== 'string')
            throw new TypeError(
                `fake sysfs: ${path} holds a ${typeof contents}; file contents are strings`);

    const blocked = new Set(unreadable);
    const paths = [...Object.keys(files), ...Object.keys(links)];

    const readText = path => {
        onRead?.(path);
        return !blocked.has(path) && Object.hasOwn(files, path) ? files[path].trim() : null;
    };

    const list = path => {
        const prefix = `${path}/`;
        const names = new Set();
        for (const candidate of paths) {
            if (!candidate.startsWith(prefix)) continue;
            names.add(candidate.slice(prefix.length).split('/')[0]);
        }
        return [...names];
    };

    const driverOf = devicePath => {
        const target = links[`${devicePath}/driver`];
        return target ? target.split('/').pop() || null : null;
    };

    return makeSysfs({readText, list, driverOf});
}

/**
 * Build the `<path>: <contents>` entries for a directory in one call.
 *
 * @param {string} dir
 * @param {Record<string, string|number>} entries
 * @returns {Record<string, string>}
 */
export function filesIn(dir, entries) {
    return Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [`${dir}/${name}`, String(value)]));
}
