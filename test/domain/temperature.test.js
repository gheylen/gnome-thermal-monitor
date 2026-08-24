// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Headroom below a trip point, on its own — the judgement that turned out not
// to be a CPU rule the moment a second driver wanted it.
//
// `test/domain/cpu.test.js` exercises all of this through `assessCpu`, where it
// is one tier of a larger verdict. These cases ask it directly, so the shared
// module has cases of its own rather than coverage borrowed from a caller that
// might stop calling it.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {
    NEAR_THROTTLE_C, describeHeadroom, temperatureLevel, tightestSensor,
} from '../../src/domain/temperature.js';

const sensor = (over = {}) =>
    ({label: null, tempC: 70, throttlePointC: 100, targetC: null, ...over});

test('the kernel band is the kernel\'s number', () => {
    // `therm_throt.c` dismisses an assert more than ten degrees below the trip
    // point as a spike. This rule calls the same distance "approaching".
    assert.equal(NEAR_THROTTLE_C, 10);
});

test('nothing measurable is null, not a guess', () => {
    assert.equal(tightestSensor([]), null);
    assert.equal(tightestSensor([sensor({tempC: null})]), null);
    assert.equal(tightestSensor([sensor({throttlePointC: null})]), null);
    assert.equal(tightestSensor([sensor({throttlePointC: 0})]), null,
        'a zero trip point is not a trip point');
});

test('the tightest is by headroom, not by temperature', () => {
    const cool = sensor({label: 'cool', tempC: 82, throttlePointC: 90});
    const hot = sensor({label: 'hot', tempC: 95, throttlePointC: 125});
    assert.equal(tightestSensor([hot, cool]).label, 'cool');
    assert.equal(tightestSensor([cool, hot]).label, 'cool', 'and not by order');
});

test('an unmeasurable channel is skipped rather than dragging the answer', () => {
    const blind = sensor({label: 'blind', tempC: null});
    const real = sensor({label: 'real', tempC: 99});
    assert.equal(tightestSensor([blind, real]).label, 'real');
});

test('the level follows the headroom, and the boundary is inside the band', () => {
    assert.equal(temperatureLevel(null), Confidence.LOW);
    assert.equal(temperatureLevel(sensor({tempC: 70})), Confidence.LOW);
    assert.equal(temperatureLevel(sensor({tempC: 90})), Confidence.MEDIUM,
        'exactly ten degrees is "close", as the kernel has it');
    assert.equal(temperatureLevel(sensor({tempC: 89})), Confidence.LOW);
    assert.equal(temperatureLevel(sensor({tempC: 100})), Confidence.HIGH);
    assert.equal(temperatureLevel(sensor({tempC: 110})), Confidence.HIGH,
        'past it reads the same: there is no negative headroom');
});

test('the target adds a level and never removes one', () => {
    assert.equal(temperatureLevel(sensor({tempC: 70, targetC: 65})), Confidence.MEDIUM);
    assert.equal(temperatureLevel(sensor({tempC: 93, targetC: 97})), Confidence.MEDIUM);
    assert.equal(temperatureLevel(sensor({tempC: 70, targetC: 97})), Confidence.LOW);
});

test('a target that is not below the trip point is not a target', () => {
    for (const targetC of [100, 110, 0, null, undefined])
        assert.equal(temperatureLevel(sensor({tempC: 70, targetC})), Confidence.LOW,
            String(targetC));
});

test('an unlabelled channel needs no attribution; a labelled one does', () => {
    assert.equal(describeHeadroom(sensor({tempC: 82})),
        '18°C below the throttle point (100°C)');
    assert.equal(describeHeadroom(sensor({label: 'junction', tempC: 82})),
        'junction at 82°C, 18°C below its throttle point (100°C)');
});

test('at or past the trip point, the distance is not restated as a number', () => {
    assert.equal(describeHeadroom(sensor({tempC: 100})), 'At the throttle point (100°C)');
    assert.equal(describeHeadroom(sensor({tempC: 104})), 'At the throttle point (100°C)');
    assert.equal(describeHeadroom(sensor({label: 'mem', tempC: 104})),
        'mem at its throttle point (100°C)');
});

test('the target clause says what the platform does about that number', () => {
    // "aims to hold" and "throttles at" are two different things, and a reader
    // must not be able to mistake the first for a second trip point.
    assert.equal(describeHeadroom(sensor({tempC: 96, targetC: 94})),
        '4°C below the throttle point (100°C) and past the 94°C it aims to hold');
    assert.equal(describeHeadroom(sensor({label: 'edge', tempC: 96, targetC: 94})),
        'edge at 96°C, 4°C below its throttle point (100°C) '
        + 'and past the 94°C it aims to hold');
});
