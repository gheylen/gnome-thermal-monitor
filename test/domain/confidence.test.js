// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
    Confidence, SEVERITY_ORDER, isNominal, isThrottling, isWorse, worstOf,
} from '../../src/domain/confidence.js';

const ALL_LEVELS = Object.values(Confidence);

test('the vocabulary is frozen and has exactly six levels', () => {
    assert.ok(Object.isFrozen(Confidence));
    assert.deepEqual([...ALL_LEVELS].sort(),
        ['confirmed', 'high', 'idle', 'low', 'medium', 'unknown']);
});

test('SEVERITY_ORDER ranks every level exactly once, worst first', () => {
    assert.ok(Object.isFrozen(SEVERITY_ORDER));
    assert.equal(new Set(SEVERITY_ORDER).size, ALL_LEVELS.length);
    for (const level of ALL_LEVELS) assert.ok(SEVERITY_ORDER.includes(level), `missing ${level}`);
    assert.equal(SEVERITY_ORDER[0], Confidence.CONFIRMED);
    assert.equal(SEVERITY_ORDER.at(-1), Confidence.IDLE);
});

test('UNKNOWN outranks IDLE — "cannot tell" is worse than "confirmed asleep"', () => {
    assert.ok(SEVERITY_ORDER.indexOf(Confidence.UNKNOWN) <
              SEVERITY_ORDER.indexOf(Confidence.IDLE));
});

test('worstOf picks the worst level present', () => {
    assert.equal(worstOf([Confidence.LOW, Confidence.HIGH, Confidence.IDLE]), Confidence.HIGH);
    assert.equal(worstOf([Confidence.IDLE, Confidence.UNKNOWN]), Confidence.UNKNOWN);
    assert.equal(worstOf([Confidence.CONFIRMED, Confidence.HIGH]), Confidence.CONFIRMED);
});

test('worstOf on nothing at all is UNKNOWN, not a crash and not "fine"', () => {
    assert.equal(worstOf([]), Confidence.UNKNOWN);
});

test('worstOf ignores levels outside the vocabulary', () => {
    assert.equal(worstOf(['bogus', Confidence.MEDIUM]), Confidence.MEDIUM);
    assert.equal(worstOf(['bogus']), Confidence.UNKNOWN);
});

test('nominal covers exactly LOW, IDLE and UNKNOWN', () => {
    const nominal = ALL_LEVELS.filter(isNominal).sort();
    assert.deepEqual(nominal, ['idle', 'low', 'unknown']);
});

test('only CONFIRMED counts as throttling', () => {
    assert.equal(isThrottling(Confidence.CONFIRMED), true);
    assert.equal(ALL_LEVELS.filter(isThrottling).length, 1);
    assert.equal(isThrottling(null), false);
});

// "Worse than" is what lets a rule compare two independent judgements — a
// measurement and a preference, say — and name only the one that decided.
test('isWorse follows the severity order, strictly', () => {
    assert.equal(isWorse(Confidence.HIGH, Confidence.MEDIUM), true);
    assert.equal(isWorse(Confidence.MEDIUM, Confidence.HIGH), false);
    assert.equal(isWorse(Confidence.CONFIRMED, Confidence.HIGH), true);
    assert.equal(isWorse(Confidence.UNKNOWN, Confidence.IDLE), true,
        '"we cannot tell" is worse than "confirmed asleep"');
});

test('no level is worse than itself', () => {
    for (const level of ALL_LEVELS)
        assert.equal(isWorse(level, level), false, `for ${level}`);
});

test('isWorse agrees with worstOf on every pair', () => {
    for (const a of ALL_LEVELS)
        for (const b of ALL_LEVELS)
            assert.equal(isWorse(a, b), a !== b && worstOf([a, b]) === a, `${a} vs ${b}`);
});
