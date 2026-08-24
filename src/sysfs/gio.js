// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Gio adapter for the Sysfs port — the only module in the read path that
// imports `gi://`.  Every operation swallows errors and reports missing data,
// because a malformed or disappearing sysfs entry must never be able to throw
// inside the GNOME Shell process.
//
// Every read here is synchronous, on the compositor's own thread.  That is why
// which attributes an adapter reads is a correctness question and not only a
// tidiness one: a sysfs `show` handler that resumes a suspended device does that
// work with the shell's main loop blocked behind it.  See `gpu-xe.js`, which
// asks the PM core rather than the driver for exactly this reason.

import Gio from 'gi://Gio';

import {makeSysfs} from './port.js';

// Strict on purpose. The port promises `null` for a file that is not valid
// UTF-8, and a lenient decoder does not fail — it substitutes U+FFFD, which
// would reach an adapter as a string that merely looks like text.
const decoder = new TextDecoder('utf-8', {fatal: true});

function readText(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return decoder.decode(bytes).trim();
    } catch {
        return null; // absent, unreadable, a directory, or not valid UTF-8
    }
}

function list(path) {
    const names = [];
    let iterator = null;
    try {
        iterator = Gio.File.new_for_path(path).enumerate_children(
            Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NONE, null
        );
        let info;
        while ((info = iterator.next_file(null)) !== null)
            names.push(info.get_name());
    } catch {
        // Absent, inaccessible, or interrupted mid-enumeration: return what we have.
    } finally {
        try { iterator?.close(null); } catch { /* nothing useful to do */ }
    }
    return names;
}

function driverOf(devicePath) {
    try {
        // NOFOLLOW_SYMLINKS asks about the link rather than what it points at,
        // which is what we want: the driver's name is in the link, and the
        // directory it resolves to is of no interest. It is not load-bearing —
        // GLib fills in `standard::symlink-target` from the lstat either way,
        // and a mutant that drops it survives the whole suite — but following a
        // link to read an attribute of the link is the wrong request to make.
        const info = Gio.File.new_for_path(`${devicePath}/driver`).query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null
        );
        return (info.get_symlink_target() ?? '').split('/').pop() || null;
    } catch {
        return null;
    }
}

/** The production Sysfs port.  Stateless, so a single frozen instance suffices. */
export const gioSysfs = makeSysfs({readText, list, driverOf});
