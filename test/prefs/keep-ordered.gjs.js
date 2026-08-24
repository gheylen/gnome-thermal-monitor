// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// `prefs.js`, loaded for real, against real libadwaita widgets.
//
// This file used to be described as impossible. The backlog said automating it
// would need "libadwaita, a virtual display, and a stripped copy of prefs.js
// (its `resource:///` import cannot resolve outside the Extensions
// application)" — and the last clause was wrong. The Extensions application's
// own JavaScript ships as a GResource, `org.gnome.Shell.Extensions.src.gresource`,
// and `Gio.resources_register()` makes `resource:///org/gnome/Shell/Extensions/…`
// resolve in any GJS process. So the real module is imported here, not a copy of
// it, and `_keepOrdered` is driven through actual `Adw.SpinRow` objects emitting
// actual `notify::value`.
//
// What it verifies is the one piece of behaviour `prefs.js` owns. Everything
// else in that file binds a row straight to its GSettings key and holds no state.
//
// Not part of `make check`, which must work offline and on a machine with no
// desktop at all: this needs GNOME Shell's data files installed and a display.
// `make test-prefs` runs it, and CI runs that in a job of its own. On a GNOME
// desktop both prerequisites are already there.

import System from 'system';
import Gio from 'gi://Gio';

// Registered before anything imports prefs.js, because that import is what
// resolves `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`.
const GRESOURCE_CANDIDATES = [
    '/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource',
    '/usr/local/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource',
];

let registered = null;
for (const path of GRESOURCE_CANDIDATES) {
    try {
        Gio.resources_register(Gio.Resource.load(path));
        registered = path;
        break;
    } catch {
        // Try the next; report properly below if none works.
    }
}

if (registered === null) {
    printerr('cannot find org.gnome.Shell.Extensions.src.gresource — install gnome-shell');
    printerr(`looked in: ${GRESOURCE_CANDIDATES.join(', ')}`);
    System.exit(1);
}

const GLib = (await import('gi://GLib')).default;
const Gtk = (await import('gi://Gtk?version=4.0')).default;
const Adw = (await import('gi://Adw')).default;

if (!Gtk.init_check()) {
    printerr('no display: run under `xvfb-run -a`, or from a graphical session');
    System.exit(1);
}

const {announce, check, equal, finish} = await import('../gjs/harness.js');
announce('prefs');
print(`#   Extensions resource: ${registered}`);

// Imported by absolute path from the working directory, which `make test-prefs`
// sets to the repository root — a relative specifier would resolve against this
// file and reach for `test/prefs/prefs.js`.
const {default: Preferences} =
    await import(`file://${GLib.get_current_dir()}/prefs.js`);

check('the real prefs.js imports under a GJS runtime', typeof Preferences === 'function');

/** A spin row shaped exactly as `_spinRow` builds one. */
const spinRow = value => new Adw.SpinRow({
    title: 'threshold',
    adjustment: new Gtk.Adjustment({
        lower: 50, upper: 125, step_increment: 1, page_increment: 5, value,
    }),
});

/**
 * Two ordered rows, with the real handler attached.
 *
 * `_keepOrdered` reads no state of its own, so it is called off the prototype —
 * constructing an `ExtensionPreferences` would need an extension context this
 * test has no business inventing.
 */
function ordered(warnC, critC) {
    const warn = spinRow(warnC);
    const critical = spinRow(critC);
    Preferences.prototype._keepOrdered(warn, critical);
    return {warn, critical};
}

// The behaviour, as `prefs.js` documents it: the row the user just edited keeps
// the value they typed, and the *other* row moves. That is the opposite of the
// domain's `Thresholds`, which sorts a stored pair of unknown provenance — and
// the difference is deliberate.
{
    const {warn, critical} = ordered(88, 94);
    warn.value = 99;
    equal('raising the warning pushes the critical up', critical.value, 99);
    equal('and the edited row keeps what was typed', warn.value, 99);
}

{
    const {warn, critical} = ordered(88, 94);
    critical.value = 60;
    equal('lowering the critical pulls the warning down', warn.value, 60);
    equal('and the edited row keeps what was typed', critical.value, 60);
}

// The condition in each handler is false once the other has moved, which is what
// stops the pair oscillating. If it did, this would not terminate.
{
    const {warn, critical} = ordered(88, 94);
    warn.value = 120;
    equal('the handlers settle rather than bouncing', critical.value, 120);
    equal('warning unchanged after settling', warn.value, 120);
}

// A move that does not cross the other value must leave it alone.
{
    const {warn, critical} = ordered(88, 94);
    warn.value = 90;
    equal('a warning below the critical moves nothing else', critical.value, 94);

    critical.value = 100;
    equal('a critical above the warning moves nothing else', warn.value, 90);
}

// The adjustment bounds are the schema's, and `test/schema.test.js` holds the
// constants in prefs.js to it. This checks the widget honours them at all.
{
    const {warn} = ordered(88, 94);
    warn.value = 400;
    equal('a value above the range is clamped by the adjustment', warn.value, 125);
    warn.value = 0;
    equal('and one below it too', warn.value, 50);
}

finish('prefs');
