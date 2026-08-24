// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Presentation — how a Snapshot reads on screen.
//
// Sits between the domain (which knows confidence, not colours) and the shell
// adapter (which knows St widgets, not wording).  Pure, so every string the user
// can see is covered by plain-Node tests.

import {Confidence, isThrottling} from './domain/confidence.js';

/**
 * Popup badges.  The filled-block ramp gives the confidence level a shape you
 * can read at a glance without relying on colour alone.
 *
 * @type {Readonly<Record<import('./domain/confidence.js').Level, string>>}
 */
export const BADGES = Object.freeze({
    [Confidence.CONFIRMED]: '████ CONFIRMED',
    [Confidence.HIGH]:      '███░ HIGH',
    [Confidence.MEDIUM]:    '██░░ MEDIUM',
    [Confidence.LOW]:       '█░░░ LOW',
    [Confidence.IDLE]:      '░░░░ IDLE',
    [Confidence.UNKNOWN]:   '░░░░ —',
});

/**
 * Panel label CSS classes; see stylesheet.css.  One class per level so a shell
 * theme can restyle a single level without forking the extension.
 *
 * @type {Readonly<Record<import('./domain/confidence.js').Level, string>>}
 */
export const STYLE_CLASSES = Object.freeze({
    [Confidence.CONFIRMED]: 'ttm-confirmed',
    [Confidence.HIGH]:      'ttm-high',
    [Confidence.MEDIUM]:    'ttm-medium',
    [Confidence.LOW]:       'ttm-low',
    [Confidence.IDLE]:      'ttm-idle',
    [Confidence.UNKNOWN]:   'ttm-unknown',
});

/** Spoken form of each level, for accessible names. */
const SPOKEN = Object.freeze({
    [Confidence.CONFIRMED]: 'throttling',
    [Confidence.HIGH]:      'thermal warning',
    [Confidence.MEDIUM]:    'temperature elevated',
    [Confidence.LOW]:       'nominal',
    [Confidence.IDLE]:      'idle',
    [Confidence.UNKNOWN]:   'no sensor data',
});

/**
 * Levels that warrant the alert glyph rather than the neutral dot.
 *
 * Both are worth looking at, and the glyph says so. What separates them is the
 * colour, which is the whole point: `.ttm-confirmed` is the error red a counter
 * earns, `.ttm-high` is a step short of it.
 */
const ALERT = new Set([Confidence.CONFIRMED, Confidence.HIGH]);

const temperatureText = temperatureC => temperatureC !== null ? `${temperatureC}°C` : '?°C';

/**
 * Shorten `text` to at most `limit` characters, marking that it was shortened.
 *
 * Counted in code points rather than UTF-16 units, so the cut cannot land
 * between the halves of a surrogate pair and leave a lone surrogate — which
 * renders as a replacement glyph.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncate(text, limit) {
    const characters = [...text];
    return characters.length > limit
        ? `${characters.slice(0, limit).join('')}…`
        : text;
}

/**
 * How wide a popup section heading may get.
 *
 * Some headings are built from kernel text — the xe adapter names a GT after
 * `gtidle/name` when it does not recognise the engine role — and a popup menu
 * item does not wrap, so an unexpectedly long value would stretch the menu off
 * the screen. Every adapter's title passes through here, so a future backend
 * that puts a sysfs string in a title inherits the same bound.
 */
const MAX_TITLE_LENGTH = 40;

/**
 * @param {import('./domain/confidence.js').Level} level
 * @returns {string}
 */
export const badgeFor = level => BADGES[level] ?? BADGES[Confidence.UNKNOWN];

/**
 * @param {import('./domain/confidence.js').Level} level
 * @returns {string}
 */
export const styleClassFor = level => STYLE_CLASSES[level] ?? STYLE_CLASSES[Confidence.UNKNOWN];

/**
 * A machine this extension has nothing to say about.
 *
 * Distinct from a sensor that failed, and the panel must not conflate them:
 * "?°C" claims there is a temperature somewhere that could not be read, which
 * on a VM or a container — where no `coretemp`, no DRM node and no accel device
 * exist at all — is a sentence about hardware that is not there. The popup says
 * "No supported hardware found"; this is the two characters of panel that have
 * to agree with it.
 */
const NOTHING_TO_REPORT = '—';

/** @param {{components?: unknown[]}} snapshot @returns {boolean} */
const foundNothing = ({components}) => Array.isArray(components) && components.length === 0;

/**
 * The top-bar text: state glyph, package temperature, and — when the CPU is
 * throttling — how many cores.
 *
 * @param {import('./domain/monitor.js').Snapshot} snapshot
 * @returns {string}
 */
export function panelLabel(snapshot) {
    const {level, temperatureC, throttlingCount} = snapshot;
    const glyph = ALERT.has(level) ? '⚠' : '●';
    if (foundNothing(snapshot)) return `${glyph} ${NOTHING_TO_REPORT}`;
    const count = throttlingCount ? ` (${throttlingCount})` : '';
    return `${glyph} ${temperatureText(temperatureC)}${count}`;
}

/**
 * Screen-reader text for the panel button.  The glyph and colour carry the
 * state visually; this carries it otherwise.
 *
 * @param {import('./domain/monitor.js').Snapshot} snapshot
 * @returns {string}
 */
export function panelAccessibleName(snapshot) {
    const {level, temperatureC, throttlingCount} = snapshot;
    if (foundNothing(snapshot))
        return 'Thermal throttle monitor: no supported hardware found';

    const state = SPOKEN[level] ?? SPOKEN[Confidence.UNKNOWN];
    const temperature = temperatureC !== null ? `, CPU ${temperatureC} degrees Celsius` : '';
    // The visual label carries this as "(3)", which reads as nothing useful
    // aloud. Spelling it out is the whole reason this function exists: a
    // screen-reader user should not get less than the panel shows.
    const count = throttlingCount
        ? `, ${throttlingCount} core${throttlingCount === 1 ? '' : 's'} throttling`
        : '';
    return `Thermal throttle monitor: ${state}${temperature}${count}`;
}

/**
 * The heading for one component's popup section.
 *
 * Internal whitespace is collapsed as well as trimmed. Some headings are built
 * from kernel text, `readText` only strips the ends, and a `PopupMenuItem` is a
 * single line: an embedded newline would render as a gap or a box rather than
 * wrapping, and the length bound would be counting characters the user cannot
 * see. One space is the only whitespace a heading can usefully contain.
 *
 * @param {string} title
 * @returns {string}
 */
export function sectionTitle(title) {
    const collapsed = (title ?? '').replace(/\s+/g, ' ').trim();
    if (collapsed === '') return 'Unknown component';
    return truncate(collapsed, MAX_TITLE_LENGTH);
}

/**
 * The two popup lines for one component.  The section heading is drawn
 * separately by the shell adapter, so neither line repeats it.
 *
 * `spoken` carries the same information without the block-glyph badge, which
 * a screen reader would otherwise announce four black squares at a time.
 *
 * @param {import('./domain/monitor.js').Verdict} verdict
 * @returns {{status: string, detail: string, spoken: string}}
 */
export function componentLines({level, summary, detail}) {
    const state = SPOKEN[level] ?? SPOKEN[Confidence.UNKNOWN];
    return {
        status: `${badgeFor(level)}   ${summary}`,
        detail: detail ? `  ${detail}` : '',
        spoken: [state, summary, detail].filter(Boolean).join(', '),
    };
}

/**
 * The title and body of the "something is throttling" notification.
 *
 * Here rather than in `extension.js` for the reason everything else user-visible
 * is: this is wording, and `extension.js` is the one file no test can execute.
 * What is left there is the two shell API calls, which no test could execute
 * either way.
 *
 * The component's own heading is bounded exactly as the popup's is — it can be
 * built from a kernel string, and a notification body is not a place to find
 * that out. A snapshot with no throttling component still produces a body: the
 * notification fires on the Monitor's throttle edge, and a rule that reported
 * the edge without naming a component would otherwise send an empty banner.
 *
 * @param {import('./domain/monitor.js').Snapshot} snapshot
 * @returns {{title: string, body: string}}
 */
export function throttleNotification({components}) {
    const culprit = (components ?? []).find(component => isThrottling(component.level));
    return {
        title: 'Thermal throttling detected',
        body: culprit
            ? `${sectionTitle(culprit.title)}: ${culprit.detail || culprit.summary}`
            : 'A component is thermally throttling.',
    };
}
