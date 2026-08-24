// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The Gio Sysfs adapter, run under a real GJS runtime against a real directory.
//
// Every other test drives the hardware adapters through an in-memory fake, so
// this is the only place the production read path is exercised.  Run it with
// `make test-gjs` (or `npm run test:gjs`); it needs `gjs` on PATH.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {gioSysfs} from '../../src/sysfs/gio.js';
import {FILES, LINKS, contractCases} from '../helpers/port-contract.js';
import {announce, check, deepEqual, equal, finish} from './harness.js';

announce('sysfs-gio');

// ── Fixture: the contract's tree, on a real filesystem ────────────────────

const root = GLib.dir_make_tmp('ttm-sysfs-XXXXXX');
const write = (relative, contents) => {
    const path = `${root}/${relative}`;
    GLib.mkdir_with_parents(path.slice(0, path.lastIndexOf('/')), 0o755);
    GLib.file_set_contents(path, contents);
    return path;
};

for (const [relative, contents] of Object.entries(FILES)) write(relative, contents);
// The driver link resolves, as it does on a real machine: /sys/.../driver
// always points at a directory that exists. A dangling one is a different thing
// for Gio to be asked about, and describing a machine that cannot exist is how
// this project has been wrong before.
GLib.mkdir_with_parents(`${root}/drivers/xe`, 0o755);
GLib.mkdir_with_parents(`${root}/nothing-here`, 0o755);
for (const [relative, target] of Object.entries(LINKS))
    Gio.File.new_for_path(`${root}/${relative}`).make_symbolic_link(target, null);

// ── The shared contract ────────────────────────────────────────────────────
//
// The same cases the in-memory fake answers under Node. Every hardware test in
// this project is written against that fake, so a disagreement here means the
// whole suite describes a machine that does not exist — and says nothing,
// because those tests are consistent with each other.

for (const {name, run, expected} of contractCases(root)) {
    const actual = run(gioSysfs);
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── What only the real adapter can be asked ────────────────────────────────

// An in-memory map of strings cannot hold a byte sequence that is not text.
GLib.file_set_contents(`${root}/device/binary`, new Uint8Array([0x41, 0xff, 0x42]));
// A lenient decoder substitutes U+FFFD and hands back a string that merely
// looks like text; the port promises null, so the decoder is strict.
equal('readText on a file that is not valid UTF-8 returns null',
    gioSysfs.readText(`${root}/device/binary`), null);

// A real sysfs attribute reports size 0 but yields contents when read; /proc has
// the same shape, so it stands in for one here.
check('readText copes with a zero-sized kernel file',
    (gioSysfs.readText('/proc/version') ?? '').startsWith('Linux'));

// A directory the fake cannot represent: one that exists and holds nothing.
deepEqual('list on an empty directory returns an empty array',
    gioSysfs.list(`${root}/nothing-here`), []);

// ── Teardown ───────────────────────────────────────────────────────────────

const remove = path => {
    const file = Gio.File.new_for_path(path);
    const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const iterator = file.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let child;
        while ((child = iterator.next_file(null)) !== null)
            remove(`${path}/${child.get_name()}`);
        iterator.close(null);
    }
    file.delete(null);
};
remove(root);

finish('gjs');
