// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The rule for a GPU that publishes temperatures and no reason registers.
//
// Its whole shape is the ceiling: `src/domain/gpu.js` reaches CONFIRMED because
// an Intel driver register asserts PROCHOT, and nothing amdgpu publishes as text
// is that. HIGH is the honest maximum, and these cases exist to keep it there.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {assessGpuTemperature} from '../../src/domain/gpu-temperature.js';
import {Thresholds} from '../../src/domain/thresholds.js';

const quiet = {packageTempC: null, packageThrottlePointC: null,
    thresholds: new Thresholds(120, 125)};
const context = {packageTempC: null, packageThrottlePointC: null,
    thresholds: new Thresholds(88, 94)};

const sensor = (label, tempC, throttlePointC = 100) =>
    ({label, tempC, throttlePointC, targetC: null});
const reading = (sensors, currentMhz = 1800) => ({sensors, currentMhz});

test('no reading at all is UNKNOWN, never "all clear"', () => {
    const verdict = assessGpuTemperature(null, null, quiet);
    assert.equal(verdict.level, Confidence.UNKNOWN);
    assert.equal(verdict.detail, '');
});

test('no measurable sensor is UNKNOWN, and still shows what did read', () => {
    const verdict = assessGpuTemperature(reading([sensor('edge', null)]), null, quiet);
    assert.equal(verdict.level, Confidence.UNKNOWN);
    assert.equal(verdict.detail, '1800 MHz');
});

test('the summary is this GPU\'s own reading, because the panel shows the CPU\'s', () => {
    const verdict = assessGpuTemperature(reading([sensor('edge', 61)]), null, quiet);
    assert.equal(verdict.summary, '61°C');
});

test('CONFIRMED is structurally unreachable', () => {
    // Every input the rule accepts, at its worst.
    for (const tempC of [100, 130, 999]) {
        const verdict = assessGpuTemperature(reading([sensor('edge', tempC)]), null, context);
        assert.equal(verdict.level, Confidence.HIGH, `at ${tempC}°C`);
    }
});

test('the clock is reported and never judged', () => {
    // A GPU idling at 300 MHz is a GPU with nothing to do. amdgpu publishes no
    // maximum beside `freq1_input`, so there is no ceiling to read it against —
    // and this project has already once painted a frequency it could not
    // explain as heat.
    for (const currentMhz of [300, 1800, 2900]) {
        const verdict = assessGpuTemperature(
            reading([sensor('edge', 61)], currentMhz), null, quiet);
        assert.equal(verdict.level, Confidence.LOW, `at ${currentMhz} MHz`);
        assert.match(verdict.detail, new RegExp(`— ${currentMhz} MHz$`));
    }
});

test('a card publishing no clock says nothing about one', () => {
    const verdict = assessGpuTemperature(reading([sensor('edge', 61)], null), null, quiet);
    assert.equal(verdict.detail, 'edge at 61°C, 39°C below its throttle point (100°C)');
});

test('each channel is measured against its own trip point', () => {
    const verdict = assessGpuTemperature(reading([
        sensor('edge', 96, 100),      // 4°C of headroom
        sensor('junction', 99, 110),  // 11°C, though it is hotter
    ]), null, quiet);
    assert.match(verdict.detail, /^edge at 96°C/);
    assert.equal(verdict.summary, '96°C');
});

test('the worse of hardware and preference wins, as everywhere else here', () => {
    const cool = reading([sensor('edge', 90, 130)]);
    assert.equal(assessGpuTemperature(cool, null, quiet).level, Confidence.LOW);
    assert.equal(assessGpuTemperature(cool, null, context).level, Confidence.MEDIUM);

    const near = reading([sensor('edge', 95, 100)]);
    assert.equal(assessGpuTemperature(near, null, quiet).level, Confidence.MEDIUM);
    assert.equal(assessGpuTemperature(near, null, context).level, Confidence.HIGH,
        'past the critical threshold the user set');
});

test('the previous reading is unused, because every signal is instantaneous', () => {
    const now = reading([sensor('edge', 61)]);
    const hot = reading([sensor('edge', 99)]);
    assert.deepEqual(assessGpuTemperature(now, hot, quiet),
        assessGpuTemperature(now, null, quiet));
});
