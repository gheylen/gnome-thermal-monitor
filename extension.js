// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Thermal Throttle Monitor — GNOME Shell adapter.
//
// This file is the driving side of the hexagon and nothing else: it owns St
// widgets, GLib timers, and GSettings, and it knows no hardware and no rules.
// Every decision it renders was made by src/domain/monitor.js and worded by
// src/presentation.js, both of which run under plain Node in the test suite.
//
// See docs/ARCHITECTURE.md.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {discoverComponents} from './src/domain/discovery.js';
import {Monitor} from './src/domain/monitor.js';
import {Thresholds} from './src/domain/thresholds.js';
import {CATEGORY_WARNINGS, DRIVERS} from './src/hardware/index.js';
import * as log from './src/log.js';
import {
    componentLines, panelAccessibleName, panelLabel, sectionTitle, styleClassFor,
    throttleNotification,
} from './src/presentation.js';
import {gioSysfs} from './src/sysfs/gio.js';

const TITLE = 'Thermal Throttle Monitor';

/** Monotonic milliseconds — immune to wall-clock jumps across suspend. */
const monotonicNowMs = () => GLib.get_monotonic_time() / 1000;

const ThermalIndicator = GObject.registerClass(
class ThermalIndicator extends PanelMenu.Button {
    constructor(settings, monitor) {
        super(0.0, TITLE);
        this._settings = settings;
        this._monitor = monitor;
        this._pollTimer = null;
        this._lingerTimer = null;
        this._lingerDeadline = null;
        this._accessibleName = null;
        this._notificationSource = null;

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ttm-label ttm-unknown',
        });
        this._labelClass = 'ttm-unknown';
        this.add_child(this._label);

        this._sections = this._buildMenu();

        this._settingsHandler = this._settings.connect('changed', (_settings, key) => {
            // No settings write takes the hardware.  A spin button writes on
            // every step, and polling for each would read all of sysfs inside
            // the compositor and chop the throttle-delta window into slivers a
            // burst can hide between.  Changing the interval re-arms the timer;
            // everything else redraws the poll we already have.
            if (key === 'poll-interval') this._armPollTimer();
            else this._redraw();
        });

        // Cleanup runs from the `destroy` signal, not from a `destroy()` method
        // override: when gnome-shell tears the panel down from C it emits the
        // signal without ever calling a JS override, and the timers would
        // outlive the actor.  `actor.destroy()` emits it too, so both paths are
        // covered by the one handler.
        //
        // The handler must NOT be called `_onDestroy`.  PanelMenu.ButtonBox
        // binds `this._onDestroy` at construction, and that lookup finds the
        // most derived definition — so naming ours that silently replaces the
        // shell's own teardown, which is what destroys the popup menu (parented
        // to Main.uiGroup, not to us) and the panel container.
        this.connect('destroy', () => this._stopWork());
    }

    /**
     * Begin polling.  Kept out of the constructor so that a failure here leaves
     * a fully-built indicator the caller can still destroy.
     */
    start() {
        this._refresh();
        this._armPollTimer();
    }

    // ── Menu ───────────────────────────────────────────────────────────────

    /** @returns {Map<string, {status: PopupMenu.PopupMenuItem, detail: PopupMenu.PopupMenuItem}>} */
    _buildMenu() {
        const sections = new Map();
        const inert = {reactive: false, can_focus: false};

        if (this._monitor.components.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No supported hardware found', inert));
            return sections;
        }

        for (const {id, title} of this._monitor.components) {
            const status = new PopupMenu.PopupMenuItem('', inert);
            const detail = new PopupMenu.PopupMenuItem('', inert);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(sectionTitle(title)));
            this.menu.addMenuItem(status);
            this.menu.addMenuItem(detail);
            sections.set(id, {status, detail});
        }
        return sections;
    }

    // ── Polling ────────────────────────────────────────────────────────────

    /** (Re)start the poll timer at the configured interval.  Does not poll. */
    _armPollTimer() {
        this._clearTimer('_pollTimer');
        // The schema's <range> already keeps this at 1 or above, and GSettings
        // falls back to the default for an out-of-range value.  Clamp anyway:
        // a zero-second timeout would spin the compositor's main loop.
        const intervalSeconds = Math.max(1, this._settings.get_int('poll-interval'));
        this._pollTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, intervalSeconds,
            () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
    }

    /** @returns {Thresholds} */
    _thresholds() {
        return new Thresholds(
            this._settings.get_int('temp-warn'),
            this._settings.get_int('temp-crit'));
    }

    /** Poll the hardware and draw the result.  Never allowed to throw into GLib. */
    _refresh() {
        try {
            this._render(this._monitor.poll(this._thresholds()));
        } catch (cause) {
            log.error('Poll failed:', cause);
        }
    }

    /**
     * Redraw after a settings change.  A settings write arrives on every step of
     * a spin button, so this re-answers the last poll rather than taking the
     * hardware — and the poll's own timing, linger and notification edge are
     * left alone.
     */
    _redraw() {
        try {
            const snapshot = this._monitor.reassess(this._thresholds());
            if (snapshot !== null) this._render(snapshot);
        } catch (cause) {
            log.error('Redraw failed:', cause);
        }
    }

    // ── Rendering ──────────────────────────────────────────────────────────

    /** @param {import('./src/domain/monitor.js').Snapshot} snapshot */
    _render(snapshot) {
        const styleClass = styleClassFor(snapshot.level);
        if (styleClass !== this._labelClass) {
            this._label.remove_style_class_name(this._labelClass);
            this._label.add_style_class_name(styleClass);
            this._labelClass = styleClass;
        }
        this._label.set_text(panelLabel(snapshot));

        // St.Label already ignores an unchanged text; the accessible name does
        // not, and notifying ATK on every poll for a string that has not moved
        // is work nobody asked for.
        const accessibleName = panelAccessibleName(snapshot);
        if (accessibleName !== this._accessibleName) {
            this.accessible_name = accessibleName;
            this._accessibleName = accessibleName;
        }

        for (const component of snapshot.components) {
            const section = this._sections.get(component.id);
            if (!section) continue;
            const lines = componentLines(component);
            section.status.label.text = lines.status;
            section.detail.label.text = lines.detail;
            // The badge is a block-glyph ramp; give assistive technology the
            // same reading in words instead of four black squares.
            section.status.label.accessible_name = lines.spoken;
            // A component with nothing to add would otherwise leave a blank row.
            section.detail.visible = lines.detail !== '';
        }

        if (snapshot.throttleStarted && this._settings.get_boolean('notify-on-throttle'))
            this._notify(snapshot);

        this._setVisible(!(this._settings.get_boolean('hide-when-nominal') && snapshot.nominal));
        this._scheduleLingerExpiry(snapshot.lingerUntilMs);
    }

    /**
     * The panel owns the button's container, so collapsing that is what removes
     * the indicator without leaving a gap behind.
     *
     * @param {boolean} visible
     */
    _setVisible(visible) {
        if (this.container.visible === visible) return;
        if (!visible) this.menu.close();
        this.container.visible = visible;
    }

    /**
     * This extension's own notification source, created on first use.
     *
     * The shell destroys a source once its last notification is dismissed
     * (`Source._onNotificationDestroy()` calls `this.destroy()` at zero), so the
     * cached reference has to be dropped with it — adding a notification to a
     * disposed source would silently show nothing.  `getSystemSource()` in the
     * shell's own `messageTray.js` is the same three lines, for the same reason.
     *
     * @returns {MessageTray.Source}
     */
    _source() {
        if (this._notificationSource) return this._notificationSource;

        const source = new MessageTray.Source({
            title: TITLE,
            // `dialog-warning` is a Status name in the freedesktop Icon Naming
            // Specification, and its `-symbolic` variant is in Adwaita's
            // `symbolic/status/` both at this extension's floor and on current
            // main — checked, because an icon name a theme lacks renders as a
            // broken image rather than falling back to anything.  The
            // specification has no thermometer, so this is the closest name
            // that is certain to resolve.
            iconName: 'dialog-warning-symbolic',
        });
        source.connect('destroy', () => {
            this._notificationSource = null;
        });
        Main.messageTray.add(source);

        this._notificationSource = source;
        return source;
    }

    /** @param {import('./src/domain/monitor.js').Snapshot} snapshot */
    _notify(snapshot) {
        const source = this._source();
        const {title, body} = throttleNotification(snapshot);

        // Not transient, which is the one behavioural difference from the
        // `Main.notify()` this replaced: that helper hangs its notification off
        // the shared "System" source and marks it `isTransient`, so a throttle
        // that happened while the machine was unattended left no trace once the
        // banner timed out.  Finding out afterwards that a build throttled the
        // laptop is most of the point of being told at all.
        source.addNotification(new MessageTray.Notification({source, title, body}));
    }

    /**
     * The panel stays red for a while after the last confirmed event.  Nothing
     * else would repaint it when that window closes between polls, so wake up
     * exactly once at the end of it.
     *
     * @param {number|null} lingerUntilMs
     */
    _scheduleLingerExpiry(lingerUntilMs) {
        // Every poll during a linger reports the same deadline.  Re-arming the
        // timer each time would churn a GLib source for no reason, so only act
        // when the deadline actually moves.
        if (lingerUntilMs === this._lingerDeadline) return;
        this._lingerDeadline = lingerUntilMs;

        this._clearTimer('_lingerTimer');
        if (lingerUntilMs === null) return;

        const remaining = Math.max(0, Math.ceil(lingerUntilMs - monotonicNowMs()));
        this._lingerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, remaining, () => {
            this._lingerTimer = null;
            this._lingerDeadline = null; // so the poll below can re-arm if needed
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Teardown ───────────────────────────────────────────────────────────

    /** @param {'_pollTimer'|'_lingerTimer'} field */
    _clearTimer(field) {
        if (this[field] === null) return;
        GLib.source_remove(this[field]);
        this[field] = null;
    }

    /**
     * Release everything this indicator owns.  Idempotent: the `destroy` signal
     * is emitted once, but not always by us.
     *
     * Deliberately not named `_onDestroy` — see the constructor.
     */
    _stopWork() {
        if (this._settingsHandler !== undefined) {
            this._settings.disconnect(this._settingsHandler);
            this._settingsHandler = undefined;
        }
        this._clearTimer('_pollTimer');
        this._clearTimer('_lingerTimer');
        this._lingerDeadline = null;
        this._sections = new Map();

        // The source is ours, so disabling the extension has to take it with
        // us — a source left in the tray outlives the code that would answer
        // for it.  Any unread notification of ours goes with it, which is the
        // right trade: the alternative is a row in the message list that
        // belongs to an extension that is no longer running.
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
    }
});

export default class ThermalThrottleMonitorExtension extends Extension {
    enable() {
        try {
            const {components, missingCategories} =
                discoverComponents(DRIVERS, gioSysfs, log.warn);
            for (const category of missingCategories) {
                const message = CATEGORY_WARNINGS[category];
                if (message) log.warn(message);
            }

            const monitor = new Monitor(components, {
                now: monotonicNowMs,
                onError: (id, cause) => log.error(`Component "${id}" failed:`, cause),
            });
            this._indicator = new ThermalIndicator(this.getSettings(), monitor);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._indicator.start();
        } catch (cause) {
            log.error('Failed to enable:', cause);
            this.disable();
        }
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
