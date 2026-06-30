// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/gpu-common.js — the shared iGPU freq-cap decision logic
// used by both the xe and i915 backends. Pure (imports only confidence.js),
// so it runs under plain Node.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {calcFreqConf} from '../lib/gpu-common.js';
import {Confidence} from '../lib/confidence.js';

// calcFreqConf(label, curFreq, maxFreq, rp0Freq, freqStr, cpuTempC, tempWarn)
const RP0 = 2000;          // hardware max boost
const WARN = 85;           // °C warn threshold
const FSTR = '1500 / 2000 MHz';
const conf = (over = {}) => calcFreqConf(
    over.label    ?? 'Render',
    'curFreq'  in over ? over.curFreq  : 1500,
    'maxFreq'  in over ? over.maxFreq  : RP0,
    'rp0Freq'  in over ? over.rp0Freq  : RP0,
    over.freqStr  ?? FSTR,
    'cpuTempC' in over ? over.cpuTempC : null,
    over.tempWarn ?? WARN,
);

test('no boost-freq reading → UNKNOWN', () => {
    const r = conf({rp0Freq: null});
    assert.equal(r.level, Confidence.UNKNOWN);
    assert.match(r.line1, /no boost freq/);
});

test('hard cap while CPU package is hot → HIGH', () => {
    // maxFreq 1000 is well below rp0*0.95 (1900) → capped; cpuTempC >= warn → hot.
    const r = conf({maxFreq: 1000, cpuTempC: 90});
    assert.equal(r.level, Confidence.HIGH);
    assert.match(r.line1, /freq capped/);
    assert.match(r.line2, /package hot/);
});

test('hard cap while CPU is cool → MEDIUM', () => {
    const r = conf({maxFreq: 1000, cpuTempC: 50});
    assert.equal(r.level, Confidence.MEDIUM);
    assert.match(r.line2, /reason unknown/);
});

test('hard cap with no CPU temp available → MEDIUM (not treated as hot)', () => {
    const r = conf({maxFreq: 1000, cpuTempC: null});
    assert.equal(r.level, Confidence.MEDIUM);
});

test('cap detection respects the 0.95 boundary (exactly 95% is NOT a cap)', () => {
    // maxFreq === rp0 * 0.95 → the `< rp0*0.95` test is false → not capped.
    const r = conf({maxFreq: RP0 * 0.95, curFreq: 1900, cpuTempC: 90});
    assert.notEqual(r.level, Confidence.HIGH);
    assert.match(r.line1, /nominal/);
});

test('cap takes precedence over below-max (capped + low cur still reports cap)', () => {
    const r = conf({maxFreq: 1000, curFreq: 300, cpuTempC: 50});
    assert.equal(r.level, Confidence.MEDIUM);
    assert.match(r.line1, /freq capped/);
});

test('no cap but running below 75% of max → LOW "below max"', () => {
    const r = conf({maxFreq: RP0, curFreq: 1000}); // 1000 < 1500
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line1, /below max/);
    assert.match(r.line2, /P-state or power limit/);
});

test('no cap and running near max → LOW "nominal"', () => {
    const r = conf({maxFreq: RP0, curFreq: 1800}); // 1800 >= 1500
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line1, /nominal/);
});

test('null maxFreq is not treated as a cap; below-max path still works', () => {
    const r = conf({maxFreq: null, curFreq: 1000});
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line1, /below max/);
});
