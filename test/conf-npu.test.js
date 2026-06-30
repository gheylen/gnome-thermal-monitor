// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/conf-npu.js — the pure NPU confidence logic extracted
// from backends/npu-intel.js. Behavior must match the original.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {npuConf} from '../lib/conf-npu.js';
import {Confidence} from '../lib/confidence.js';

const ctx = {cpuTempC: 50, tempWarn: 85};
const st = (over = {}) => ({curFreq: 1000, maxFreq: 2000, busyUs: 5000, ...over});

test('no data → UNKNOWN', () => {
    assert.equal(npuConf(null, null, ctx).level, Confidence.UNKNOWN);
    assert.equal(npuConf(st({curFreq: null}), null, ctx).level, Confidence.UNKNOWN);
    assert.equal(npuConf(st({maxFreq: 0}), null, ctx).level, Confidence.UNKNOWN);
});

test('curFreq 0 → IDLE', () => {
    const r = npuConf(st({curFreq: 0}), null, ctx);
    assert.equal(r.level, Confidence.IDLE);
    assert.match(r.line1, /idle/);
});

test('active but busy counter unreadable → UNKNOWN', () => {
    assert.equal(npuConf(st({busyUs: null}), st(), ctx).level, Confidence.UNKNOWN);
});

test('active, no new work this interval → LOW', () => {
    const prev = st({busyUs: 5000});
    const r = npuConf(st({busyUs: 5000}), prev, ctx); // busyDelta 0
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line2, /no new work/);
});

test('active near max frequency → LOW nominal', () => {
    const prev = st({busyUs: 1000});
    const r = npuConf(st({curFreq: 1900, maxFreq: 2000, busyUs: 5000}), prev, ctx); // 95%
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line2, /nominal/);
});

test('active below 85% while package hot → LOW with thermal-unconfirmed note', () => {
    const prev = st({busyUs: 1000});
    const r = npuConf(
        st({curFreq: 1000, maxFreq: 2000, busyUs: 5000}), prev,
        {cpuTempC: 90, tempWarn: 85}
    ); // 50%, hot
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line2, /thermal unconfirmed/);
});

test('first poll (no prev) is handled gracefully', () => {
    const r = npuConf(st(), null, ctx);
    assert.equal(r.level, Confidence.LOW); // busyDelta 0 → no new work path
});
