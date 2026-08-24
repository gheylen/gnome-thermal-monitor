// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Monitor — the aggregate that turns a set of hardware components into the one
// thing the panel needs: a Snapshot.
//
// Everything the shell adapter used to decide inline lives here instead, so all
// of it is testable without GNOME: threshold normalisation, package-temperature
// propagation, worst-level selection, the throttle linger, and the notification
// edge.  The adapter's remaining job is to draw a Snapshot and to schedule the
// next poll.
//
// The only I/O is `component.read()`, which reaches the kernel through the
// injected Sysfs port.  Components are contractually forbidden from throwing;
// Monitor enforces that anyway, isolating a misbehaving component as UNKNOWN
// rather than losing the whole poll.

import {Confidence, isNominal, isThrottling, worstOf} from './confidence.js';

/**
 * How long the panel stays red after the last confirmed throttle event, so a
 * burst shorter than the poll interval cannot flash past unnoticed.
 */
export const LINGER_MS = 30_000;

/**
 * @typedef {object} Verdict          What a rule concludes about one component.
 * @property {import('./confidence.js').Level} level
 * @property {string} summary         Headline, shown beside the badge.
 * @property {string} detail          Supporting line; '' to omit.
 * @property {number} [throttlingCount]
 *   How many independent units of this component are confirmed throttling — for
 *   a CPU, physical cores. The panel shows it beside the temperature. A number,
 *   not a rendered string: how it is written is `src/presentation.js`'s to
 *   decide, and the spoken form differs from the visual one.
 *
 * @typedef {object} Context          Shared inputs handed to every rule.
 * @property {number|null} packageTempC  CPU package temperature, if any component reports one.
 * @property {number|null} packageThrottlePointC
 *   The trip point of *that same sensor*, where it publishes one. The pair is
 *   only comparable if it comes from one channel, so both are taken from the
 *   component that supplied the temperature, or neither is.
 * @property {import('./thresholds.js').Thresholds} thresholds
 *
 * @typedef {object} Component        A discovered piece of hardware.
 * @property {string} id              Unique across all components.
 * @property {string} title           Section heading in the popup.
 * @property {() => object|null} read
 * @property {(reading: object|null, previous: object|null|undefined, context: Context) => Verdict} assess
 * @property {(reading: object|null) => number|null} [temperatureC]
 *   Optional projection.  A component that measures the CPU package offers it
 *   here; the first non-null wins and becomes `Context.packageTempC`.
 * @property {(reading: object|null) => number|null} [throttlePointC]
 *   Optional projection, only consulted on the component that won above.  The
 *   temperature and the trip point are only comparable when they describe the
 *   same sensor.
 *
 * @typedef {object} Snapshot
 * @property {import('./confidence.js').Level} level  Worst level, linger applied.
 * @property {boolean} nominal
 * @property {number|null} temperatureC
 * @property {number|null} throttlingCount
 *   How many units are confirmed throttling, from the first component that both
 *   is CONFIRMED and reports a count. A count is a claim about confirmed
 *   throttling, so a verdict below that level cannot supply one even if it
 *   carries the field — and during a linger, when nothing is currently
 *   throttling, there is no count to show.
 * @property {boolean} throttleStarted   True only on the poll that enters CONFIRMED.
 * @property {number|null} lingerUntilMs Clock time the linger expires, or null.
 * @property {({id: string, title: string} & Verdict)[]} components
 */

const RULE_FAILED = Object.freeze({
    level: Confidence.UNKNOWN,
    summary: 'No data',
    detail: 'Assessment failed',
});

/** A rule is contractually required to answer; anything else is a broken rule. */
const isVerdict = value =>
    value !== null && typeof value === 'object' && typeof value.level === 'string';

export class Monitor {
    #components;
    #previous = new Map();
    #previousLevel = null;
    #lastPoll = null;
    #lingerMs;
    #lingerUntilMs = null;
    #now;
    #onError;

    /**
     * The clock is required, and deliberately has no default.
     *
     * The linger is arithmetic on it, and the only clock that works here is a
     * monotonic one: a wall clock jumping backwards across suspend/resume used
     * to hold the panel red indefinitely. `Date.now` is exactly the wrong
     * answer, so it is not sitting here as the fallback — a caller that forgets
     * the clock is told, rather than silently getting the old bug back.
     *
     * @param {Component[]} components
     * @param {object} options
     * @param {() => number} options.now  Millisecond clock, monotonic.
     * @param {number} [options.lingerMs]
     * @param {(id: string, error: unknown) => void} [options.onError]
     */
    constructor(components, {now, lingerMs = LINGER_MS, onError} = {}) {
        if (typeof now !== 'function')
            throw new TypeError('Monitor requires a monotonic clock: {now: () => number}');
        this.#components = Object.freeze([...components]);
        this.#now = now;
        this.#lingerMs = lingerMs;
        this.#onError = onError;
    }

    /** @returns {readonly Component[]} */
    get components() {
        return this.#components;
    }

    /**
     * Read every component once and derive the panel state.
     *
     * @param {import('./thresholds.js').Thresholds} thresholds
     * @returns {Snapshot}
     */
    poll(thresholds) {
        const readings = this.#components.map(component => this.#read(component));
        const previous = this.#previous;

        // Advance the window before assessing, but hand the assessment the
        // window as it stood, so every rule sees the same previous poll.
        this.#previous = new Map(this.#components.map((component, i) =>
            [component.id, readings[i]]));
        this.#lastPoll = {readings, previous};

        const assessed = this.#assessAll(readings, previous, thresholds, this.#onError);
        this.#advanceLinger(assessed.worst);

        const level = this.#level(assessed.worst);
        const throttleStarted = isThrottling(level) && !isThrottling(this.#previousLevel);
        this.#previousLevel = level;

        return this.#snapshot(assessed, level, throttleStarted);
    }

    /**
     * Re-answer the last poll against different thresholds, without touching the
     * hardware or any of the state a poll advances.
     *
     * The thresholds are settings, and a settings write arrives on every step of
     * a spin button.  Re-polling for each one would read all of sysfs inside the
     * compositor, chop the throttle-delta window into slivers a burst can hide
     * between, and could fire a notification as a side effect of the user
     * adjusting a number.
     *
     * The error sink is deliberately not passed: a component that already failed
     * has already been reported, and repeating it would put one line in the
     * journal per step of a spin button.  The trade is that a rule which fails
     * only under the *new* thresholds fails quietly until the next poll.
     *
     * @param {import('./thresholds.js').Thresholds} thresholds
     * @returns {Snapshot|null} null before the first poll.
     */
    reassess(thresholds) {
        if (this.#lastPoll === null) return null;
        const {readings, previous} = this.#lastPoll;

        const assessed = this.#assessAll(readings, previous, thresholds, undefined);
        return this.#snapshot(assessed, this.#level(assessed.worst), false);
    }

    /**
     * Run every rule.  Pure with respect to this Monitor's state — it reads
     * none of it and writes none of it.
     *
     * @param {(object|null)[]} readings
     * @param {Map<string, object|null>} previous
     * @param {import('./thresholds.js').Thresholds} thresholds
     * @param {((id: string, error: unknown) => void)|undefined} report
     * @returns {{verdicts: Verdict[], packageTempC: number|null,
     *            worst: import('./confidence.js').Level}}
     */
    #assessAll(readings, previous, thresholds, report) {
        const context = {...this.#packageThermal(readings, report), thresholds};
        const verdicts = this.#components.map((component, i) =>
            this.#assess(component, readings[i], previous.get(component.id), context, report));

        return {
            verdicts,
            packageTempC: context.packageTempC,
            worst: worstOf(verdicts.map(verdict => verdict.level)),
        };
    }

    /**
     * Open the linger window on a confirmed throttle, and close it once it has
     * run out.  Only a poll does this: a reassessment answers the same readings
     * and must not move time along.
     *
     * @param {import('./confidence.js').Level} worst
     */
    #advanceLinger(worst) {
        const now = this.#now();
        if (isThrottling(worst)) this.#lingerUntilMs = now + this.#lingerMs;
        else if (this.#lingerUntilMs !== null && now >= this.#lingerUntilMs)
            this.#lingerUntilMs = null;
    }

    /**
     * @param {import('./confidence.js').Level} worst
     * @returns {import('./confidence.js').Level} What the panel should show.
     */
    #level(worst) {
        return this.#lingerUntilMs !== null ? Confidence.CONFIRMED : worst;
    }

    /**
     * @param {{verdicts: Verdict[], packageTempC: number|null}} assessed
     * @param {import('./confidence.js').Level} level
     * @param {boolean} throttleStarted
     * @returns {Snapshot}
     */
    #snapshot({verdicts, packageTempC}, level, throttleStarted) {
        return {
            level,
            nominal: isNominal(level),
            temperatureC: packageTempC,
            throttlingCount: verdicts.find(verdict =>
                isThrottling(verdict.level) && verdict.throttlingCount > 0)
                ?.throttlingCount ?? null,
            throttleStarted,
            lingerUntilMs: this.#lingerUntilMs,
            components: this.#components.map((component, i) => ({
                id: component.id,
                title: component.title,
                ...verdicts[i],
            })),
        };
    }

    #read(component) {
        try {
            return component.read() ?? null;
        } catch (error) {
            this.#onError?.(component.id, error);
            return null;
        }
    }

    #assess(component, reading, previousReading, context, report) {
        let verdict;
        try {
            verdict = component.assess(reading, previousReading, context);
        } catch (error) {
            report?.(component.id, error);
            return RULE_FAILED;
        }
        if (isVerdict(verdict)) return verdict;
        report?.(component.id, new TypeError(`assess() returned ${typeof verdict}`));
        return RULE_FAILED;
    }

    /**
     * The shared CPU package temperature and, from the same sensor, the trip
     * point it is measured against.
     *
     * Both or neither: a temperature from one channel and a TjMax from another
     * would produce a headroom that describes no hardware at all. That extends
     * to failure — a component whose *trip point* projection throws loses its
     * temperature too, and the search moves on. The two are one answer, and
     * half of one is the answer this rule exists to refuse.
     *
     * @param {(object|null)[]} readings
     * @param {((id: string, error: unknown) => void)|undefined} report
     * @returns {{packageTempC: number|null, packageThrottlePointC: number|null}}
     */
    #packageThermal(readings, report) {
        for (const [i, component] of this.#components.entries()) {
            if (!component.temperatureC) continue;
            try {
                const tempC = component.temperatureC(readings[i]);
                if (tempC === null || tempC === undefined) continue;
                return {
                    packageTempC: tempC,
                    packageThrottlePointC:
                        component.throttlePointC?.(readings[i]) ?? null,
                };
            } catch (error) {
                report?.(component.id, error);
            }
        }
        return {packageTempC: null, packageThrottlePointC: null};
    }
}
