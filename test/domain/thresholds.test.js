// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The two temperatures arrive as independent GSettings integers, so the pair
// can be nonsense. The point of this type is that the rest of the domain can
// never be handed a nonsensical one.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Thresholds} from '../../src/domain/thresholds.js';

test('a sensible pair is kept as given', () => {
    const thresholds = new Thresholds(88, 94);
    assert.equal(thresholds.warnC, 88);
    assert.equal(thresholds.critC, 94);
});

test('an inverted pair is ordered rather than obeyed', () => {
    const thresholds = new Thresholds(94, 88);
    assert.equal(thresholds.warnC, 88);
    assert.equal(thresholds.critC, 94);
});

test('an equal pair is allowed: warn and critical coincide', () => {
    const thresholds = new Thresholds(90, 90);
    assert.equal(thresholds.warnC, 90);
    assert.equal(thresholds.critC, 90);
    assert.equal(thresholds.isWarm(90), true);
    assert.equal(thresholds.isCritical(90), true);
});

test('the boundaries are inclusive', () => {
    const thresholds = new Thresholds(88, 94);
    assert.equal(thresholds.isWarm(87), false);
    assert.equal(thresholds.isWarm(88), true);
    assert.equal(thresholds.isCritical(93), false);
    assert.equal(thresholds.isCritical(94), true);
});

test('critical is a kind of warm', () => {
    const thresholds = new Thresholds(88, 94);
    assert.equal(thresholds.isWarm(99), true, 'so a rule checking warm need not also check critical');
});

test('no reading is not a warm reading', () => {
    // This was written out at each call site as `tempC !== null && tempC >= warnC`,
    // which is one place per site for the null to be forgotten.
    const thresholds = new Thresholds(88, 94);
    for (const nothing of [null, undefined, NaN, Infinity, '95']) {
        assert.equal(thresholds.isWarm(nothing), false, `isWarm(${String(nothing)})`);
        assert.equal(thresholds.isCritical(nothing), false, `isCritical(${String(nothing)})`);
    }
});

test('a constructed pair cannot be reshaped afterwards', () => {
    const thresholds = new Thresholds(88, 94);
    assert.ok(Object.isFrozen(thresholds));
    assert.throws(() => { thresholds.warnC = 10; }, TypeError);
});
