// SPDX-FileCopyrightText: 2026 Glenn Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Unit tests for lib/conf-gpu-xe.js — the pure xe iGPU confidence logic
// extracted from backends/gpu-xe.js. Behavior must match the original.

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {gpuXeConf} from '../lib/conf-gpu-xe.js';
import {Confidence} from '../lib/confidence.js';

const base = {
    actFreq: 1500, curFreq: 1500, maxFreq: 2000, rp0Freq: 2000,
    isIdle: false, throttleStatus: 0, reasonThermal: 0, reasonProchot: 0,
    reasons: 'none',
};
const ctx = {cpuTempC: 50, tempWarn: 85};
const conf = (over = {}) => gpuXeConf({...base, ...over}, 'Render', ctx);

test('no state or no rp0 → UNKNOWN', () => {
    assert.equal(gpuXeConf(null, 'Render', ctx).level, Confidence.UNKNOWN);
    assert.equal(conf({rp0Freq: null}).level, Confidence.UNKNOWN);
});

test('idle → IDLE', () => {
    const r = conf({isIdle: true});
    assert.equal(r.level, Confidence.IDLE);
    assert.match(r.line1, /idle/);
});

test('PROCHOT reason → CONFIRMED', () => {
    const r = conf({reasonProchot: 1});
    assert.equal(r.level, Confidence.CONFIRMED);
    assert.match(r.line2, /PROCHOT/);
});

test('thermal reason → HIGH', () => {
    const r = conf({reasonThermal: 1});
    assert.equal(r.level, Confidence.HIGH);
    assert.match(r.line2, /thermal/);
});

test('PROCHOT takes precedence over thermal', () => {
    assert.equal(conf({reasonProchot: 1, reasonThermal: 1}).level, Confidence.CONFIRMED);
});

test('generic throttle status → MEDIUM with reason string', () => {
    const r = conf({throttleStatus: 1, reasons: 'power'});
    assert.equal(r.level, Confidence.MEDIUM);
    assert.match(r.line2, /power/);
});

test('throttle status with reasons "none" → MEDIUM "unknown"', () => {
    const r = conf({throttleStatus: 1, reasons: 'none'});
    assert.equal(r.level, Confidence.MEDIUM);
    assert.match(r.line2, /unknown/);
});

test('no throttle signal falls through to freq-cap logic (nominal → LOW)', () => {
    const r = conf({curFreq: 1800});
    assert.equal(r.level, Confidence.LOW);
    assert.match(r.line1, /nominal/);
});

test('freq cap + hot package via fall-through → HIGH', () => {
    const r = gpuXeConf({...base, maxFreq: 1000}, 'Render', {cpuTempC: 90, tempWarn: 85});
    assert.equal(r.level, Confidence.HIGH);
    assert.match(r.line2, /package hot/);
});
