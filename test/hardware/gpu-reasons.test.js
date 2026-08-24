// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Which of a GPU's throttle-reason flags mean heat.
//
// This is the hardware knowledge the domain rule deliberately does not have, so
// it is the piece that has to be right about Intel's registers: a power limit
// listed here would be presented to the user as heat, which is the one mistake
// this project exists to avoid.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {THERMAL_REASONS, firstThermalReason} from '../../src/hardware/gpu-reasons.js';

/** A reader over a plain `attribute → value` map, as an adapter supplies. */
const reading = flags => attribute =>
    Object.hasOwn(flags, attribute) ? flags[attribute] : null;

test('nothing asserted is no reason at all', () => {
    assert.equal(firstThermalReason(reading({})), null, 'nothing published');
    assert.equal(firstThermalReason(reading({thermal: 0, ratl: 0})), null, 'published and clear');
});

test('an asserted flag is named', () => {
    assert.equal(firstThermalReason(reading({thermal: 1})), 'thermal');
    assert.equal(firstThermalReason(reading({ratl: 1})), 'thermal (running average limit)');
    assert.equal(firstThermalReason(reading({vr_thermalert: 1})),
        'voltage regulator thermal alert');
});

// xe_gt_throttle.c gives Crescent Island `reason_ratl` and `reason_prochot` but
// no `reason_thermal` at all, replacing it with three of its own. Reading every
// name and taking the first that is set is what covers both platforms without
// parsing the `reasons` display string, which carries no stability guarantee.
test('the Crescent Island set is covered, and costs nothing elsewhere', () => {
    assert.equal(firstThermalReason(reading({soc_thermal: 1})), 'SoC thermal');
    assert.equal(firstThermalReason(reading({mem_thermal: 1})), 'memory thermal');
    assert.equal(firstThermalReason(reading({vr_thermal: 1})), 'voltage regulator thermal');

    // On a consumer part those three do not exist, and an absent attribute is
    // null rather than 0 — which must not read as asserted.
    assert.equal(firstThermalReason(reading({thermal: 0})), null);
});

test('the most specific reason wins when several are asserted', () => {
    assert.equal(firstThermalReason(reading({thermal: 1, ratl: 1, soc_thermal: 1})), 'thermal');
    assert.equal(firstThermalReason(reading({ratl: 1, mem_thermal: 1})),
        'thermal (running average limit)');
});

test('only 1 counts as asserted', () => {
    // A reason attribute is a boolean the driver renders as 0 or 1. Anything
    // else is a value this adapter does not understand, and guessing at it is
    // how a power limit comes to be reported as heat.
    for (const value of [null, 0, -1, 2, '1'])
        assert.equal(firstThermalReason(reading({thermal: value})), null, String(value));
});

test('no power or current limit is listed as thermal', () => {
    // The whole point. pl1 in particular is asserted under essentially any real
    // GPU workload, so listing it would paint the panel amber during video
    // playback and call it heat.
    const attributes = THERMAL_REASONS.map(reason => reason.attribute);
    for (const power of ['pl1', 'pl2', 'pl4', 'vr_tdc', 'iccmax', 'psys_pl1', 'psys_pl2'])
        assert.ok(!attributes.includes(power), `${power} is a power limit, not heat`);
    assert.ok(!attributes.includes('status'), 'status is any limit at all');
    assert.ok(!attributes.includes('prochot'), 'prochot is proof, and outranks these');
});

test('the table is ordered, frozen, and free of duplicates', () => {
    assert.ok(Object.isFrozen(THERMAL_REASONS));
    const attributes = THERMAL_REASONS.map(reason => reason.attribute);
    assert.deepEqual(attributes, [...new Set(attributes)]);
    assert.equal(attributes[0], 'thermal', 'the common case is checked first');
    for (const {attribute, label} of THERMAL_REASONS) {
        assert.match(attribute, /^[a-z][a-z_]*$/, attribute);
        assert.ok(label.length > 0, attribute);
    }
});
