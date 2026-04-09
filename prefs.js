// Preferences UI for Thermal Throttle Monitor
// Rendered inside the GNOME Extensions application.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ThermalThrottlePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'temperature-symbolic',
        });
        window.add(page);

        // Temperature thresholds
        const thresholds = new Adw.PreferencesGroup({
            title: 'CPU Temperature Thresholds',
            description: 'Controls panel colour for the CPU. ' +
                'Red is also triggered by confirmed kernel throttle events regardless of these values.',
        });
        page.add(thresholds);

        this._spinRow(thresholds, settings, 'temp-warn',
            'Warning (°C)',
            'Panel turns orange above this temperature',
            50, 105);

        this._spinRow(thresholds, settings, 'temp-crit',
            'Critical (°C)',
            'Panel turns red; throttling imminent',
            50, 105);

        // Polling
        const polling = new Adw.PreferencesGroup({
            title: 'Polling',
            description: 'Changes take effect immediately.',
        });
        page.add(polling);

        this._spinRow(polling, settings, 'poll-interval',
            'Poll Interval (seconds)',
            'How often to read thermal sensors and throttle counters',
            1, 60);
    }

    _spinRow(group, settings, key, title, subtitle, min, max) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower: min,
                upper: max,
                step_increment: 1,
                value: settings.get_int(key),
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
}
