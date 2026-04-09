// Shared sysfs read helpers.
// All functions return null / [] on any error — never throw.

import Gio from 'gi://Gio';

const _textDecoder = new TextDecoder();

export function readFile(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return _textDecoder.decode(bytes).trim();
    } catch {
        return null;
    }
}

export function listDir(path) {
    const names = [];
    let iter = null;
    try {
        iter = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null
        );
        let info;
        while ((info = iter.next_file(null)) !== null)
            names.push(info.get_name());
    } catch {
        // path absent, inaccessible, or enumeration error — return what we have
    } finally {
        try { iter?.close(null); } catch { /* ignore close errors */ }
    }
    return names.sort();
}

// Returns the basename of the symlink at <devicePath>/driver, or null.
export function readDriverName(devicePath) {
    try {
        const info = Gio.File.new_for_path(`${devicePath}/driver`).query_info(
            Gio.FILE_ATTRIBUTE_STANDARD_SYMLINK_TARGET,
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null
        );
        return (info.get_symlink_target() ?? '').split('/').pop() || null;
    } catch {
        return null;
    }
}

// parseInt that returns null instead of NaN.
export function parseIntSafe(s) {
    if (s === null || s === undefined) return null;
    const n = parseInt(s, 10);
    return isNaN(n) ? null : n;
}
