// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/panel-policy.js — the pure presentation decisions used by
// the "hide when nominal" and "notify on throttle" settings.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {isNominalLevel, crossedIntoThrottle} from '../lib/panel-policy.js';
import {Confidence} from '../lib/confidence.js';

test('nominal levels are LOW, IDLE, UNKNOWN', () => {
    assert.equal(isNominalLevel(Confidence.LOW), true);
    assert.equal(isNominalLevel(Confidence.IDLE), true);
    assert.equal(isNominalLevel(Confidence.UNKNOWN), true);
});

test('warning and throttle levels are not nominal', () => {
    assert.equal(isNominalLevel(Confidence.MEDIUM), false);
    assert.equal(isNominalLevel(Confidence.HIGH), false);
    assert.equal(isNominalLevel(Confidence.CONFIRMED), false);
});

test('crossing into throttle fires only on the edge into CONFIRMED', () => {
    assert.equal(crossedIntoThrottle(Confidence.CONFIRMED, Confidence.HIGH), true);
    assert.equal(crossedIntoThrottle(Confidence.CONFIRMED, Confidence.LOW), true);
    assert.equal(crossedIntoThrottle(Confidence.CONFIRMED, null), true);
});

test('staying CONFIRMED does not re-fire (debounces during linger)', () => {
    assert.equal(crossedIntoThrottle(Confidence.CONFIRMED, Confidence.CONFIRMED), false);
});

test('non-throttle transitions never fire', () => {
    assert.equal(crossedIntoThrottle(Confidence.HIGH, Confidence.LOW), false);
    assert.equal(crossedIntoThrottle(Confidence.LOW, Confidence.CONFIRMED), false);
});
