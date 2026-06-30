// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/conf-gpu-i915.js — the pure i915 iGPU confidence logic
// extracted from backends/gpu-i915.js. Behavior must match the original.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {gpuI915Conf} from '../lib/conf-gpu-i915.js';
import {Confidence} from '../lib/confidence.js';

const ctx = {cpuTempC: 50, tempWarn: 85};
const st = (over = {}) => ({curFreq: 1500, maxFreq: 2000, rp0Freq: 2000, isIdle: false, ...over});

test('no state or no rp0 → UNKNOWN', () => {
    assert.equal(gpuI915Conf(null, 'GT', ctx).level, Confidence.UNKNOWN);
    assert.equal(gpuI915Conf(st({rp0Freq: null}), 'GT', ctx).level, Confidence.UNKNOWN);
});

test('idle → IDLE', () => {
    const r = gpuI915Conf(st({isIdle: true}), 'GT', ctx);
    assert.equal(r.level, Confidence.IDLE);
    assert.match(r.line1, /idle/);
});

test('active nominal → LOW via freq-cap logic', () => {
    const r = gpuI915Conf(st({curFreq: 1800}), 'GT', ctx);
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line1, /nominal/);
});

test('hard cap + hot package → HIGH', () => {
    const r = gpuI915Conf(st({maxFreq: 1000}), 'GT', {cpuTempC: 90, tempWarn: 85});
    assert.equal(r.level, Confidence.HIGH);
    assert.match(r.line2, /package hot/);
});
