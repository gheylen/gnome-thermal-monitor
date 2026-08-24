// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Confidence — the ubiquitous language of this extension.
//
// A verdict is not "the component is throttling"; it is "here is how certain we
// are that it is, and why".  That honesty is the whole point of the project: a
// kernel PROCHOT counter is proof, a capped frequency is a hint, and the panel
// must not present the second as the first.
//
// This module owns the vocabulary and its ordering.  It knows nothing about
// panels, colours, or glyphs — see src/presentation.js for that.

/** @typedef {typeof Confidence[keyof typeof Confidence]} Level */

export const Confidence = Object.freeze({
    /**
     * A hardware counter said so: the CPU's thermal (TCC) event counter, or a
     * GPU driver's PROCHOT reason flag. Proof, and the only level that is.
     */
    CONFIRMED: 'confirmed',
    /**
     * The strongest thing short of a counter. A GPU reporting a thermal limit
     * asserted; a sensor at or past its own trip point; or a temperature past
     * the user's critical threshold, which is a preference rather than
     * evidence and is worded as one.
     */
    HIGH: 'high',
    /**
     * A measured distance rather than a fact: a sensor within 10 °C of its own
     * trip point, or a temperature past the user's warning threshold. In
     * practice only the CPU reaches it — a GPU publishes no distance to a trip
     * point, so it has nothing to be approaching.
     */
    MEDIUM: 'medium',
    /**
     * Running below maximum, or held under a ceiling somebody set. Something to
     * report, no thermal cause established — and a software frequency cap lives
     * here rather than higher precisely because it is the user's own power
     * policy read back to them.
     */
    LOW: 'low',
    /** The component is inactive, so there is nothing to throttle. */
    IDLE: 'idle',
    /** No usable sensor data. */
    UNKNOWN: 'unknown',
});

/**
 * Worst first.  UNKNOWN ranks above IDLE deliberately: "we cannot tell" is a
 * worse thing to report than "it is confirmed asleep".
 *
 * @type {readonly Level[]}
 */
export const SEVERITY_ORDER = Object.freeze([
    Confidence.CONFIRMED,
    Confidence.HIGH,
    Confidence.MEDIUM,
    Confidence.LOW,
    Confidence.UNKNOWN,
    Confidence.IDLE,
]);

/**
 * Levels at which there is nothing worth interrupting the user about.  Drives
 * the "hide when nominal" setting.
 */
const NOMINAL = new Set([Confidence.LOW, Confidence.IDLE, Confidence.UNKNOWN]);

/**
 * The single level the panel should show for a set of components: the worst
 * one present.  An empty set means we know nothing at all.
 *
 * @param {Iterable<Level>} levels
 * @returns {Level}
 */
export function worstOf(levels) {
    const present = new Set(levels);
    return SEVERITY_ORDER.find(level => present.has(level)) ?? Confidence.UNKNOWN;
}

/**
 * Strictly worse, in the order above.  Equal levels are not worse than each
 * other, which is the distinction that matters wherever two judgements are
 * compared to decide which of them to name.
 *
 * @param {Level} level
 * @param {Level} than
 * @returns {boolean}
 */
export function isWorse(level, than) {
    return level !== than && worstOf([level, than]) === level;
}

/**
 * @param {Level} level
 * @returns {boolean} true when the level warrants no attention.
 */
export function isNominal(level) {
    return NOMINAL.has(level);
}

/**
 * @param {Level} level
 * @returns {boolean} true only for hardware-confirmed throttling.
 */
export function isThrottling(level) {
    return level === Confidence.CONFIRMED;
}
