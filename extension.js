// Thermal Throttle Monitor — GNOME Shell extension
//
// Colour-coded panel indicator for Intel CPU / iGPU / NPU thermal throttle
// state.  All hardware knowledge lives in backends/; this file is the generic
// core that drives any set of components discovered at runtime.
//
// Architecture: see backends/index.js for the backend/component interface and
// instructions for adding support for new hardware.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Confidence, CONF_SEVERITY, CONF_BADGE, CONF_COLOR} from './lib/confidence.js';
import {BACKENDS, CATEGORY_WARNINGS} from './backends/index.js';

const SCHEMA_ID        = 'org.gnome.shell.extensions.thermal-throttle-monitor';
const THROTTLE_LINGER_S = 30;

// ─── Panel indicator ──────────────────────────────────────────────────────────

const ThermalIndicator = GObject.registerClass(
class ThermalIndicator extends PanelMenu.Button {
    constructor(settings) {
        super(0.0, 'Thermal Throttle Monitor');
        this._settings = settings;

        // Discover hardware; each backend returns zero or more Component objects.
        this._entries = []; // [{ component, prevState }]
        const foundCategories = new Set();
        for (const backend of BACKENDS) {
            const components = backend.discover();
            if (components.length > 0)
                foundCategories.add(backend.category);
            for (const component of components)
                this._entries.push({component, prevState: null});
        }

        // One warning per missing hardware category.
        for (const [cat, msg] of Object.entries(CATEGORY_WARNINGS)) {
            if (!foundCategories.has(cat))
                console.warn(`[ThermalThrottleMonitor] ${msg}`);
        }

        // Seed prevState so the first poll delta is zero.
        for (const entry of this._entries)
            entry.prevState = entry.component.readState();

        this._lingerActive = false;
        this._lingerTimer  = null;
        this._pollTimer    = null;
        this._settingsConn = null;

        // Panel label.
        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding: 0 6px;',
        });
        this.add_child(this._label);

        // Popup menu — one section per discovered component.
        this._sections = {}; // id → { sep, statusItem, detailItem }
        this._buildMenu();

        // Begin polling; restart timer when the interval setting changes.
        this._settingsConn = this._settings.connect(
            'changed::poll-interval', () => this._startPolling()
        );
        this._startPolling();
    }

    // ── Menu construction ──────────────────────────────────────────────────

    _buildMenu() {
        for (const {component} of this._entries)
            this._addSection(component.id, component.sectionTitle);
    }

    _addSection(id, title) {
        const sep        = new PopupMenu.PopupSeparatorMenuItem(title);
        const statusItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        const detailItem = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this.menu.addMenuItem(sep);
        this.menu.addMenuItem(statusItem);
        this.menu.addMenuItem(detailItem);
        this._sections[id] = {sep, statusItem, detailItem};
    }

    _updateSection(id, conf) {
        const s = this._sections[id];
        if (!s) return;
        s.statusItem.label.text = `${CONF_BADGE[conf.level]}   ${conf.line1}`;
        s.detailItem.label.text = conf.line2 ? `  ${conf.line2}` : '';
    }

    // ── Polling ────────────────────────────────────────────────────────────

    _startPolling() {
        if (this._pollTimer !== null) {
            GLib.source_remove(this._pollTimer);
            this._pollTimer = null;
        }
        const interval = this._settings.get_int('poll-interval');
        this._update();
        this._pollTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval,
            () => { this._update(); return GLib.SOURCE_CONTINUE; }
        );
    }

    // ── Core update ────────────────────────────────────────────────────────

    _update() {
        try {
            this._doUpdate();
        } catch (e) {
            console.error('[ThermalThrottleMonitor] Unexpected error in _update():', e);
        }
    }

    _doUpdate() {
        const pollMs   = this._settings.get_int('poll-interval') * 1000;
        const tempWarn = this._settings.get_int('temp-warn');
        const tempCrit = this._settings.get_int('temp-crit');
        const context  = {cpuTempC: null, pollMs, tempWarn, tempCrit};

        // Pass 1: read all states; let each component enrich shared context.
        const states = this._entries.map(({component}) => {
            const state = component.readState();
            component.contributeContext?.(state, context);
            return state;
        });

        // Pass 2: calculate confidence for every component.
        const confs = this._entries.map(({component, prevState}, i) =>
            component.calcConf(states[i], prevState, context)
        );

        // Advance prev-state.
        this._entries.forEach((entry, i) => { entry.prevState = states[i]; });

        // Linger: keep the panel red for THROTTLE_LINGER_S after the last
        // confirmed thermal event, so brief throttle bursts remain visible.
        if (confs.some(c => c.level === Confidence.CONFIRMED)) {
            this._lingerActive = true;
            this._resetLingerTimer();
        }

        // Worst confidence level across all components.
        const worstLevel = CONF_SEVERITY.find(
            l => confs.some(c => c.level === l)
        ) ?? Confidence.UNKNOWN;
        const panelLevel = this._lingerActive ? Confidence.CONFIRMED : worstLevel;

        // Panel label: <icon><temp>[<suffix>]
        // context.cpuTempC is populated by the CPU backend's contributeContext.
        // panelSuffix (e.g. ' 40%') is an optional field on a conf object.
        const tempStr     = context.cpuTempC !== null ? `${context.cpuTempC}°C` : '?°C';
        const icon        = (panelLevel === Confidence.CONFIRMED ||
                             panelLevel === Confidence.HIGH) ? '⚠ ' : '● ';
        const panelSuffix = confs.find(c => c.panelSuffix)?.panelSuffix ?? '';

        this._label.set_style(
            `font-size: 11px; padding: 0 6px; color: ${CONF_COLOR[panelLevel]};`
        );
        this._label.set_text(`${icon}${tempStr}${panelSuffix}`);

        // Update popup menu sections.
        this._entries.forEach(({component}, i) =>
            this._updateSection(component.id, confs[i])
        );
    }

    // ── Linger timer ───────────────────────────────────────────────────────

    _resetLingerTimer() {
        if (this._lingerTimer !== null) {
            GLib.source_remove(this._lingerTimer);
            this._lingerTimer = null;
        }
        this._lingerTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, THROTTLE_LINGER_S, () => {
                this._lingerActive = false;
                this._lingerTimer  = null;
                this._update();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    destroy() {
        if (this._settingsConn !== null) {
            this._settings.disconnect(this._settingsConn);
            this._settingsConn = null;
        }
        if (this._pollTimer !== null) {
            GLib.source_remove(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._lingerTimer !== null) {
            GLib.source_remove(this._lingerTimer);
            this._lingerTimer = null;
        }
        this._sections = null;
        super.destroy();
    }
});

// ─── Extension lifecycle ──────────────────────────────────────────────────────

export default class ThermalThrottleMonitor extends Extension {
    enable() {
        this._indicator = new ThermalIndicator(this.getSettings(SCHEMA_ID));
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
