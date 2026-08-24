// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The Sysfs port — the one outbound dependency every hardware adapter is
// allowed to have.  Adapters never touch `gi://` or the filesystem directly;
// they receive a Sysfs object and ask it for text, integers, and directory
// listings.  Production wires in src/sysfs/gio.js; tests wire in an in-memory
// fake (test/helpers/fake-sysfs.js).
//
// This module is pure: no I/O, no GJS.  It defines the contract, derives the
// convenience operations from the three primitives, and guarantees the
// invariants every adapter relies on (never throws; deterministic ordering).

/**
 * @typedef {object} SysfsPrimitives  The three operations an adapter must supply.
 * @property {(path: string) => string|null} readText
 *   Whole-file contents, trimmed.  `null` if absent, unreadable, or not UTF-8.
 * @property {(path: string) => string[]} list
 *   Entry names directly under `path`.  `[]` if absent or unreadable.
 * @property {(path: string) => string|null} driverOf
 *   Basename of the `driver` symlink under a device directory, or `null`.
 *
 * @typedef {SysfsPrimitives & {readInt: (path: string) => number|null}} Sysfs
 *   The port as adapters see it.  `list` is additionally guaranteed to be
 *   sorted in natural order (`cpu2` before `cpu10`).
 */

/**
 * Parse a sysfs integer.  Deliberately strict: sysfs integer attributes hold a
 * bare decimal number, so anything else (empty, hex, "1200 kHz", overflow) is
 * missing data rather than a value to guess at.
 *
 * @param {string|null|undefined} text
 * @returns {number|null}
 */
export function parseInteger(text) {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) ? value : null;
}

/**
 * Order names the way a human reads them: digit runs compare numerically, so
 * `cpu2` sorts before `cpu10`.  Directory order is otherwise unspecified by
 * the kernel, and several adapters index into the result across polls, so a
 * total, stable order is part of the port's contract.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function naturalCompare(a, b) {
    const chunks = s => s.match(/\d+|\D+/g) ?? [];
    const left = chunks(a), right = chunks(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const l = left[i], r = right[i];
        const bothNumeric = /^\d/.test(l) && /^\d/.test(r);
        if (bothNumeric) {
            const diff = Number(l) - Number(r);
            if (diff !== 0) return Math.sign(diff);
            // Equal in value but not in spelling — `cpu01` beside `cpu1`. Order
            // them by the text so the result is a total order rather than one
            // that leaves ties to whatever order the kernel happened to list.
            if (l !== r) return l < r ? -1 : 1;
        } else if (l !== r) {
            return l < r ? -1 : 1;
        }
    }
    return Math.sign(left.length - right.length);
}

/**
 * Build a Sysfs port from its three primitives, adding the derived operations
 * and the ordering guarantee in one place so every adapter behaves alike.
 *
 * @param {SysfsPrimitives} primitives
 * @returns {Sysfs}
 */
export function makeSysfs({readText, list, driverOf}) {
    return Object.freeze({
        readText,
        driverOf,
        list: path => [...list(path)].sort(naturalCompare),
        readInt: path => parseInteger(readText(path)),
    });
}
