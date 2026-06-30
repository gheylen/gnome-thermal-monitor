// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/confidence.js — the shared confidence vocabulary.
// Pure module (no gi:// imports), so it runs under plain Node.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    Confidence,
    CONF_SEVERITY,
    CONF_BADGE,
    CONF_STYLE_CLASS,
} from '../lib/confidence.js';

const ALL_LEVELS = Object.values(Confidence);

test('Confidence enum is frozen and has the six expected levels', () => {
    assert.ok(Object.isFrozen(Confidence));
    assert.deepEqual(
        [...ALL_LEVELS].sort(),
        ['confirmed', 'high', 'idle', 'low', 'medium', 'unknown'].sort()
    );
});

test('CONF_SEVERITY lists every level exactly once', () => {
    assert.equal(CONF_SEVERITY.length, ALL_LEVELS.length);
    assert.equal(new Set(CONF_SEVERITY).size, CONF_SEVERITY.length);
    for (const level of ALL_LEVELS)
        assert.ok(CONF_SEVERITY.includes(level), `missing ${level}`);
});

test('CONF_SEVERITY is ordered worst-to-best', () => {
    // CONFIRMED is the worst (first); IDLE is the best (last).
    assert.equal(CONF_SEVERITY[0], Confidence.CONFIRMED);
    assert.equal(CONF_SEVERITY.at(-1), Confidence.IDLE);
    // UNKNOWN ranks above IDLE — "no data" is worse than "confirmed idle".
    assert.ok(
        CONF_SEVERITY.indexOf(Confidence.UNKNOWN) <
        CONF_SEVERITY.indexOf(Confidence.IDLE)
    );
});

test('CONF_SEVERITY.find picks the worst level present (panel logic)', () => {
    const present = [Confidence.LOW, Confidence.HIGH, Confidence.IDLE];
    const worst = CONF_SEVERITY.find(l => present.includes(l));
    assert.equal(worst, Confidence.HIGH);
});

test('every level has a badge and a style class', () => {
    for (const level of ALL_LEVELS) {
        assert.equal(typeof CONF_BADGE[level], 'string', `badge for ${level}`);
        assert.ok(CONF_BADGE[level].length > 0, `non-empty badge for ${level}`);
        assert.match(CONF_STYLE_CLASS[level], /^ttm-/, `ttm- class for ${level}`);
    }
});

test('style classes are unique per level', () => {
    const classes = Object.values(CONF_STYLE_CLASS);
    assert.equal(new Set(classes).size, classes.length);
});
