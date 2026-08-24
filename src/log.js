// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Diagnostics port.  Everything the extension says to the journal goes through
// here, so `journalctl | grep ThermalThrottleMonitor` catches all of it.

const PREFIX = '[ThermalThrottleMonitor]';

/** @param {string} message */
export function warn(message) {
    console.warn(`${PREFIX} ${message}`);
}

/**
 * @param {string} message
 * @param {unknown} [cause]  Omitted rather than logged when there is none: a
 *   `console.error(msg, undefined)` writes a bare "undefined" into the journal.
 */
export function error(message, cause) {
    if (cause === undefined) console.error(`${PREFIX} ${message}`);
    else console.error(`${PREFIX} ${message}`, cause);
}
