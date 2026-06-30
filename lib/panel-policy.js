// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure presentation decisions, kept out of extension.js so they can be tested
// without the GJS runtime.

import {Confidence} from './confidence.js';

// "Nothing worth showing": the panel is at a calm level. Used by the
// "hide when nominal" setting to decide whether to show the indicator.
const NOMINAL = new Set([Confidence.LOW, Confidence.IDLE, Confidence.UNKNOWN]);

export function isNominalLevel(level) {
    return NOMINAL.has(level);
}

// True only on the transition INTO a confirmed throttle event, so a notification
// fires once per throttle burst rather than every poll. prevLevel may be null
// (first poll).
export function crossedIntoThrottle(level, prevLevel) {
    return level === Confidence.CONFIRMED && prevLevel !== Confidence.CONFIRMED;
}
