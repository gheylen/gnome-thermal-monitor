// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The Sysfs port's own guarantees: strict integer parsing, natural ordering,
// and the derived operations every adapter relies on.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {makeSysfs, naturalCompare, parseInteger} from '../../src/sysfs/port.js';
import {fakeSysfs} from '../helpers/fake-sysfs.js';

test('parseInteger accepts a bare decimal integer, with or without a sign', () => {
    assert.equal(parseInteger('42'), 42);
    assert.equal(parseInteger('  1200\n'), 1200);
    assert.equal(parseInteger('-5'), -5);
    assert.equal(parseInteger('+5'), 5);
    assert.equal(parseInteger('0'), 0);
});

test('parseInteger rejects anything that is not purely an integer', () => {
    // parseInt() would return 1200 for "1200 kHz" and 0 for "0x10"; a sysfs
    // attribute that does not hold a bare integer is missing data, not a guess.
    for (const input of ['1200 kHz', '0x10', '1.5', '', '   ', 'none', 'abc'])
        assert.equal(parseInteger(input), null, `for ${JSON.stringify(input)}`);
});

test('parseInteger rejects non-strings and unsafe magnitudes', () => {
    assert.equal(parseInteger(null), null);
    assert.equal(parseInteger(undefined), null);
    assert.equal(parseInteger(42), null);
    assert.equal(parseInteger('9'.repeat(30)), null);
});

test('naturalCompare orders digit runs numerically', () => {
    assert.deepEqual(
        ['cpu10', 'cpu2', 'cpu1', 'cpu20'].sort(naturalCompare),
        ['cpu1', 'cpu2', 'cpu10', 'cpu20']);
    assert.deepEqual(
        ['thermal_zone11', 'thermal_zone2'].sort(naturalCompare),
        ['thermal_zone2', 'thermal_zone11']);
});

test('naturalCompare orders nested digit runs left to right', () => {
    assert.deepEqual(
        ['a1b10', 'a1b2', 'a2b1', 'a10b1'].sort(naturalCompare),
        ['a1b2', 'a1b10', 'a2b1', 'a10b1']);
});

// A comparator that is not a total order makes Array.sort's result depend on
// the input order, which would make directory listings — and therefore the
// per-core counter indices that are compared across polls — non-deterministic.
// `deepEqual(sorted, sorted)` and "no entries were lost" both pass for `() => 0`,
// so the properties have to be checked directly.
test('digit runs equal in value but not in spelling still get an order', () => {
    // `cpu01` and `cpu1` are the same number. Calling them equal would leave the
    // result to whatever order the kernel listed them in, which is the one thing
    // the port promises not to do.
    assert.notEqual(naturalCompare('a01', 'a1'), 0);
    assert.deepEqual(['a1', 'a01', 'a001'].sort(naturalCompare),
        ['a001', 'a01', 'a1']);
    assert.deepEqual(['a001', 'a01', 'a1'].sort(naturalCompare),
        ['a001', 'a01', 'a1'], 'and the same whichever order they arrive in');
});

test('naturalCompare is a total order', () => {
    const names = ['gt1', 'gt0', 'tile0', 'name', 'gt10', 'a1b2', 'a1b10', 'gt0', '',
        'a01', 'a1', 'a001', 'cpu007', 'cpu7'];
    // `|| 0` folds -0 into 0; assert.strictEqual tells the two apart.
    const sign = (a, b) => Math.sign(naturalCompare(a, b)) || 0;

    for (const a of names) {
        assert.equal(sign(a, a), 0, `reflexive: ${a}`);
        for (const b of names) {
            assert.equal(sign(a, b), -sign(b, a) || 0, `antisymmetric: ${a} vs ${b}`);
            for (const c of names) {
                if (sign(a, b) <= 0 && sign(b, c) <= 0)
                    assert.ok(sign(a, c) <= 0, `transitive: ${a} <= ${b} <= ${c}`);
            }
        }
    }
});

test('naturalCompare gives the same order whatever order it is handed', () => {
    const names = ['gt10', 'a1b2', 'gt0', 'tile0', 'name', 'gt1', 'a1b10', 'gt01'];
    const expected = [...names].sort(naturalCompare);
    // Rotations, so the input order genuinely differs each time.
    for (let i = 1; i < names.length; i++) {
        const rotated = [...names.slice(i), ...names.slice(0, i)];
        assert.deepEqual(rotated.sort(naturalCompare), expected, `rotated by ${i}`);
    }
    assert.deepEqual(expected,
        ['a1b2', 'a1b10', 'gt0', 'gt01', 'gt1', 'gt10', 'name', 'tile0']);
});

test('makeSysfs derives readInt from readText', () => {
    const sysfs = fakeSysfs({files: {'/sys/x/value': '77\n', '/sys/x/junk': 'none'}});
    assert.equal(sysfs.readInt('/sys/x/value'), 77);
    assert.equal(sysfs.readInt('/sys/x/junk'), null);
    assert.equal(sysfs.readInt('/sys/x/absent'), null);
});

test('makeSysfs sorts every listing naturally, whatever order the adapter returns', () => {
    const sysfs = makeSysfs({
        readText: () => null,
        driverOf: () => null,
        list: () => ['cpu10', 'cpu1', 'cpu2'],
    });
    assert.deepEqual(sysfs.list('/anything'), ['cpu1', 'cpu2', 'cpu10']);
});

test('the port is frozen so no adapter can mutate the contract', () => {
    assert.ok(Object.isFrozen(fakeSysfs()));
});

test('fake sysfs lists immediate children only, and reads through directories as null', () => {
    const sysfs = fakeSysfs({files: {
        '/sys/a/b/c': '1',
        '/sys/a/d': '2',
    }});
    assert.deepEqual(sysfs.list('/sys/a'), ['b', 'd']);
    assert.deepEqual(sysfs.list('/sys/a/b'), ['c']);
    assert.deepEqual(sysfs.list('/sys/missing'), []);
    assert.equal(sysfs.readText('/sys/a/b'), null, 'a directory is not readable text');
});

test('fake sysfs models an entry that exists but cannot be read', () => {
    const sysfs = fakeSysfs({files: {'/sys/a/x': '1'}, unreadable: ['/sys/a/x']});
    assert.equal(sysfs.readText('/sys/a/x'), null);
    assert.deepEqual(sysfs.list('/sys/a'), ['x']);
});

test('driverOf reads the basename of the driver symlink', () => {
    const sysfs = fakeSysfs({links: {'/sys/dev/driver': '../../../bus/pci/drivers/xe'}});
    assert.equal(sysfs.driverOf('/sys/dev'), 'xe');
    assert.equal(sysfs.driverOf('/sys/other'), null);
});
