// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The two temperatures at which this extension starts caring.
//
// They arrive as a pair of independent GSettings integers, so nothing stops a
// user — or a stray dconf write — from setting the warning above the critical.
// Ordering them at the boundary means the rest of the domain cannot be handed a
// pair that makes no sense, rather than each rule having to re-establish that
// for itself.
//
// The predicates live here for the same reason: `tempC !== null && tempC >= warnC`
// was written out wherever it was needed, which is one place for the null
// handling to be forgotten.

/** A temperature the hardware would not produce; treated as no reading. */
const isReading = tempC => typeof tempC === 'number' && Number.isFinite(tempC);

export class Thresholds {
    #warnC;
    #critC;

    /**
     * @param {number} warnC  Raw setting; may be above `critC`.
     * @param {number} critC  Raw setting; may be below `warnC`.
     */
    constructor(warnC, critC) {
        this.#warnC = Math.min(warnC, critC);
        this.#critC = Math.max(warnC, critC);
        Object.freeze(this);
    }

    /** @returns {number} The lower of the pair, whichever way round they arrived. */
    get warnC() {
        return this.#warnC;
    }

    /** @returns {number} The higher of the pair. */
    get critC() {
        return this.#critC;
    }

    /**
     * @param {number|null} tempC
     * @returns {boolean} At or past the point where throttling is imminent.
     */
    isCritical(tempC) {
        return isReading(tempC) && tempC >= this.#critC;
    }

    /**
     * @param {number|null} tempC
     * @returns {boolean} At or past the point worth mentioning.
     *   True for anything critical too: critical is a kind of warm.
     */
    isWarm(tempC) {
        return isReading(tempC) && tempC >= this.#warnC;
    }
}
