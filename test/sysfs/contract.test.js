// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The in-memory fake, held to the same contract as the Gio adapter.
//
// Every hardware test in this suite is written against the fake. If it answers
// differently from the port that ships, those tests describe a machine that does
// not exist — and stay green while doing it, because they agree with each other.
// The same cases run under `gjs` in test/gjs/sysfs-gio.gjs.js.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {fakeSysfs} from '../helpers/fake-sysfs.js';
import {FILES, LINKS, contractCases} from '../helpers/port-contract.js';

const ROOT = '/sys/contract';
const prefix = entries =>
    Object.fromEntries(Object.entries(entries).map(([path, value]) => [`${ROOT}/${path}`, value]));

const sysfs = fakeSysfs({files: prefix(FILES), links: prefix(LINKS)});

for (const {name, run, expected} of contractCases(ROOT))
    test(`fake: ${name}`, () => assert.deepEqual(run(sysfs), expected));

// A fixture describes bytes on a disk. A number in one is a fixture that has
// stopped doing that, and it used to surface as `.trim is not a function` from
// somewhere inside an adapter rather than as the path that is wrong.
test('a fixture holding something that is not text is refused, with the path', () => {
    assert.throws(() => fakeSysfs({files: {'/sys/x/temp1_input': 55_000}}),
        /\/sys\/x\/temp1_input holds a number/);
    assert.throws(() => fakeSysfs({files: {'/sys/x/name': null}}), /holds a object/);
    assert.doesNotThrow(() => fakeSysfs({files: {'/sys/x/name': '55000'}}));
});
