// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences adapter — rendered inside the GNOME Extensions application.
//
// Every row binds straight to its GSettings key, so this file holds no state of
// its own.  The one piece of behaviour is keeping the warning threshold at or
// below the critical one: the extension orders them defensively anyway, but a
// UI that lets you type an impossible pair and then quietly ignores it is worse
// than one that cannot show you the pair at all.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The schema is the enforcing authority; test/schema.test.js holds these to it.
//
// The upper bound is 125 because that is the highest TjMax in coretemp's own
// table, and a threshold the hardware can never reach is a threshold that never
// fires — which is how a user on such a part turns this preference off and
// leaves the reporting to the throttle point.
const TEMP_MIN = 50, TEMP_MAX = 125;
const POLL_MIN = 1, POLL_MAX = 60;

export default class ThermalThrottleMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Settings'});
        window.add(page);

        const thresholds = new Adw.PreferencesGroup({
            title: 'CPU Temperature Thresholds',
            description: 'Extra warnings, on top of what the hardware reports. The ' +
                'popup already measures against this CPU\'s own throttle point ' +
                '(TjMax), and a confirmed kernel throttle event turns the panel red ' +
                'regardless of these values. Set them if you want to be told sooner.',
        });
        page.add(thresholds);

        const warn = this._spinRow(thresholds, settings, 'temp-warn',
            'Warning (°C)', 'Panel turns amber at or above this temperature',
            TEMP_MIN, TEMP_MAX);
        const critical = this._spinRow(thresholds, settings, 'temp-crit',
            'Critical (°C)', 'Panel turns orange-red at or above this temperature',
            TEMP_MIN, TEMP_MAX);
        this._keepOrdered(warn, critical);

        const polling = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'Changes take effect immediately.',
        });
        page.add(polling);

        this._spinRow(polling, settings, 'poll-interval',
            'Poll Interval (seconds)',
            'How often to read thermal sensors and throttle counters',
            POLL_MIN, POLL_MAX);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviour);

        this._switchRow(behaviour, settings, 'hide-when-nominal',
            'Hide when nominal',
            'Hide the indicator while nothing is throttling; show it on warnings or throttling');
        this._switchRow(behaviour, settings, 'notify-on-throttle',
            'Notify on throttling',
            'Show a desktop notification when a confirmed throttle event begins');
    }

    /**
     * Push whichever row the user did not touch, so warning never exceeds
     * critical.  Each handler's condition is false once the other has moved,
     * which is what stops the two from bouncing off each other.
     *
     * Note this pushes rather than swaps, unlike `Thresholds` in the domain.
     * The two answer different questions: here the user just typed a value and
     * must keep it, so the *other* row moves; there an already-stored pair of
     * unknown provenance has to be made sense of, so the smaller value is
     * simply the warning.  Both hold the same invariant; only the edit being
     * respected differs.
     *
     * @param {Adw.SpinRow} warn
     * @param {Adw.SpinRow} critical
     */
    _keepOrdered(warn, critical) {
        warn.connect('notify::value', () => {
            if (warn.value > critical.value) critical.value = warn.value;
        });
        critical.connect('notify::value', () => {
            if (critical.value < warn.value) warn.value = critical.value;
        });
    }

    _switchRow(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }

    _spinRow(group, settings, key, title, subtitle, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
        return row;
    }
}
