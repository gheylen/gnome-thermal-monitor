// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/conf-cpu.js — the pure Intel CPU confidence logic.
// The headline signal is "how many cores throttled since the last poll",
// counted from per-core PROCHOT counters.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {cpuConf} from '../lib/conf-cpu.js';
import {Confidence} from '../lib/confidence.js';

const ctx = {tempWarn: 88, tempCrit: 94};
// state: { throttleTimes: number[] (per core, ms; null if unreadable), tempC }
const st = (throttleTimes, tempC = 60) => ({throttleTimes, tempC});

test('no state → UNKNOWN', () => {
    assert.equal(cpuConf(null, null, ctx).level, Confidence.UNKNOWN);
});

test('cores whose counter advanced are CONFIRMED and counted', () => {
    const prev = st([100, 100, 100, 100]);
    const cur  = st([150, 100, 200, 100]); // cores 0 and 2 advanced
    const r = cpuConf(cur, prev, ctx);
    assert.equal(r.level, Confidence.CONFIRMED);
    assert.match(r.line2, /2 of 4 cores throttling/);
    assert.match(r.line2, /PROCHOT/);
    assert.equal(r.panelSuffix, ' (2)');
});

test('all cores throttling reports N of N', () => {
    const r = cpuConf(st([5, 5, 5, 5]), st([0, 0, 0, 0]), ctx);
    assert.equal(r.level, Confidence.CONFIRMED);
    assert.match(r.line2, /4 of 4 cores throttling/);
});

test('counter reset on a core (delta negative) is not counted', () => {
    const prev = st([100, 100]);
    const cur  = st([50, 150]); // core 0 reset (50<100), core 1 advanced
    const r = cpuConf(cur, prev, ctx);
    assert.equal(r.level, Confidence.CONFIRMED);
    assert.match(r.line2, /1 of 2 cores throttling/);
});

test('unreadable per-core value (null) is not counted', () => {
    const prev = st([100, 100]);
    const cur  = st([null, 150]);
    const r = cpuConf(cur, prev, ctx);
    assert.match(r.line2, /1 of 2 cores throttling/);
});

test('first poll (no prev) → no throttle delta, falls to temperature', () => {
    const r = cpuConf(st([100, 100], 60), null, ctx);
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line2, /Nominal/);
});

test('no throttling, temp at critical → HIGH', () => {
    const r = cpuConf(st([10, 10], 95), st([10, 10]), ctx);
    assert.equal(r.level, Confidence.HIGH);
    assert.match(r.line2, /critical/);
});

test('no throttling, temp elevated → MEDIUM', () => {
    const r = cpuConf(st([10, 10], 90), st([10, 10]), ctx);
    assert.equal(r.level, Confidence.MEDIUM);
    assert.match(r.line2, /Elevated/);
});

test('temperature is shown; null temp renders as ?°C', () => {
    const r = cpuConf(st([10, 10], null), st([10, 10]), ctx);
    assert.match(r.line1, /\?°C/);
});

test('throttling still CONFIRMED even when temperature is unreadable', () => {
    const r = cpuConf(st([50, 10], null), st([10, 10]), ctx);
    assert.equal(r.level, Confidence.CONFIRMED);
});

test('length mismatch between polls is handled safely (no crash, no count)', () => {
    const r = cpuConf(st([10, 10, 10], 60), st([10, 10]), ctx);
    assert.equal(r.level, Confidence.LOW); // can't compare → temperature path
});

// AMD reuse contract: AMD has no per-core PROCHOT counter, so its backend feeds
// an empty throttleTimes array. cpuConf must then never report CONFIRMED and must
// fall through to the temperature thresholds (capped at HIGH).
test('empty cores array (AMD-style) → never CONFIRMED, temperature drives level', () => {
    assert.equal(cpuConf(st([], 95), st([]), ctx).level, Confidence.HIGH);     // critical
    assert.equal(cpuConf(st([], 90), st([]), ctx).level, Confidence.MEDIUM);   // elevated
    assert.equal(cpuConf(st([], 60), st([]), ctx).level, Confidence.LOW);      // nominal
});
