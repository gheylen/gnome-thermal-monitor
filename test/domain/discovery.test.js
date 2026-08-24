// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {discoverComponents} from '../../src/domain/discovery.js';
import {fakeSysfs} from '../helpers/fake-sysfs.js';

const SYSFS = fakeSysfs();
const component = id => ({id, title: id, read: () => null, assess: () => null});
const driver = (name, category, components) => ({name, category, discover: () => components});

test('components from every driver that found hardware are collected in order', () => {
    const {components} = discoverComponents([
        driver('A', 'cpu', [component('cpu:a')]),
        driver('B', 'gpu', [component('gpu:b:0'), component('gpu:b:1')]),
    ], SYSFS);
    assert.deepEqual(components.map(c => c.id), ['cpu:a', 'gpu:b:0', 'gpu:b:1']);
});

test('the sysfs port is handed to each driver', () => {
    let received = null;
    discoverComponents([{name: 'A', category: 'cpu', discover: sysfs => { received = sysfs; return []; }}],
        SYSFS);
    assert.equal(received, SYSFS);
});

test('categories where nothing was found are reported', () => {
    const {missingCategories} = discoverComponents([
        driver('A', 'cpu', [component('cpu:a')]),
        driver('B', 'gpu', []),
        driver('C', 'npu', []),
    ], SYSFS);
    assert.deepEqual(missingCategories, ['gpu', 'npu']);
});

test('a category is only missing when every driver in it came up empty', () => {
    const {missingCategories} = discoverComponents([
        driver('xe', 'gpu', []),
        driver('i915', 'gpu', [component('gpu:i915:0')]),
    ], SYSFS);
    assert.deepEqual(missingCategories, []);
});

test('a driver that throws is skipped, and the rest still run', () => {
    const warnings = [];
    const {components} = discoverComponents([
        {name: 'Exploding', category: 'cpu', discover() { throw new Error('bad sysfs'); }},
        driver('Fine', 'npu', [component('npu:x')]),
    ], SYSFS, message => warnings.push(message));

    assert.deepEqual(components.map(c => c.id), ['npu:x']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Exploding.*bad sysfs/);
});

test('a driver returning nothing at all is treated as "no hardware"', () => {
    const {components, missingCategories} = discoverComponents(
        [{name: 'Quiet', category: 'cpu', discover: () => undefined}], SYSFS);
    assert.deepEqual(components, []);
    assert.deepEqual(missingCategories, ['cpu']);
});

test('a duplicate component id is refused, keeping the first claimant', () => {
    // Two drivers sharing an id would silently share a popup section and a
    // previous-reading slot, corrupting both.
    const warnings = [];
    const {components} = discoverComponents([
        driver('First', 'cpu', [{...component('cpu'), title: 'First CPU'}]),
        driver('Second', 'cpu', [{...component('cpu'), title: 'Second CPU'}]),
    ], SYSFS, message => warnings.push(message));

    assert.deepEqual(components.map(c => c.title), ['First CPU']);
    assert.match(warnings[0], /Second.*re-used component id "cpu"/);
});

test('a driver whose components were all refused does not claim its category', () => {
    const {missingCategories} = discoverComponents([
        driver('First', 'cpu', [component('cpu')]),
        driver('Second', 'npu', [component('cpu')]),
    ], SYSFS, () => {});
    assert.deepEqual(missingCategories, ['npu']);
});

test('duplicate ids within a single driver are refused too', () => {
    const warnings = [];
    const {components} = discoverComponents(
        [driver('Sloppy', 'gpu', [component('gt'), component('gt')])],
        SYSFS, message => warnings.push(message));
    assert.equal(components.length, 1);
    assert.equal(warnings.length, 1);
});

test('discovery works with no warning sink attached', () => {
    assert.doesNotThrow(() => discoverComponents(
        [{name: 'Exploding', category: 'cpu', discover() { throw new Error('x'); }}], SYSFS));
});

test('an empty registry yields nothing and complains about nothing', () => {
    assert.deepEqual(discoverComponents([], SYSFS), {components: [], missingCategories: []});
});

test('a driver returning something that is not a list is refused, not iterated', () => {
    const warnings = [];
    const {components} = discoverComponents(
        [{name: 'Confused', category: 'cpu', discover: () => ({id: 'cpu'})}],
        SYSFS, message => warnings.push(message));
    assert.deepEqual(components, []);
    assert.match(warnings[0], /Confused.*not a component list/);
});

test('a driver returning null is treated as "no hardware", without a warning', () => {
    const warnings = [];
    const {components, missingCategories} = discoverComponents(
        [{name: 'Absent', category: 'npu', discover: () => null}],
        SYSFS, message => warnings.push(message));
    assert.deepEqual(components, []);
    assert.deepEqual(missingCategories, ['npu']);
    assert.deepEqual(warnings, []);
});

test('a malformed component costs its driver, not the whole extension', () => {
    // Reaching for `.id` on junk would throw out of discovery, so a single bad
    // third-party backend would take every other backend's components with it.
    const warnings = [];
    const malformed = [undefined, null, 'cpu', 42, {}, {id: 'x'},
        {id: 'x', title: 'X'}, {id: 'x', title: 'X', read: () => null},
        {id: '', title: 'X', read: () => null, assess: () => null}];

    const {components} = discoverComponents([
        {name: 'Sloppy', category: 'cpu', discover: () => [...malformed, component('cpu:ok')]},
        driver('Fine', 'npu', [component('npu:x')]),
    ], SYSFS, message => warnings.push(message));

    assert.deepEqual(components.map(c => c.id), ['cpu:ok', 'npu:x'],
        'the good components on both sides survive');
    assert.equal(warnings.length, malformed.length);
    for (const warning of warnings) assert.match(warning, /Sloppy.*not a component/);
});

test('discovery never throws, whatever a driver hands it', () => {
    for (const returned of [[undefined], [null], ['cpu'], [{}], undefined, null, 'nope', 42])
        assert.doesNotThrow(() => discoverComponents(
            [{name: 'Chaos', category: 'cpu', discover: () => returned}], SYSFS, () => {}),
        `for ${JSON.stringify(returned)}`);
});

// The Monitor keys its previous-reading map and the popup sections by `id`, so
// a getter answering differently on a later read would split one component in
// two — one section updating, another frozen.
test('a component id is read once and fixed', () => {
    let reads = 0;
    const shifty = {
        get id() { return ++reads <= 1 ? 'cpu:intel' : `cpu:changed-${reads}`; },
        title: 'CPU', read: () => null, assess: () => null,
    };
    const {components} = discoverComponents(
        [driver('Shifty', 'cpu', [shifty])], SYSFS, () => {});

    assert.equal(components.length, 1);
    assert.equal(components[0].id, 'cpu:intel');
    assert.equal(components[0].id, 'cpu:intel', 'and it stays that way');
});

test('a component with a throwing getter costs its driver, not the extension', () => {
    const warnings = [];
    const {components} = discoverComponents([
        {name: 'Hostile', category: 'cpu', discover: () => [{
            get id() { throw new Error('third-party getter blew up'); },
            title: 'CPU', read: () => null, assess: () => null,
        }]},
        driver('Fine', 'npu', [component('npu:x')]),
    ], SYSFS, message => warnings.push(message));

    assert.deepEqual(components.map(c => c.id), ['npu:x']);
    assert.match(warnings[0], /Hostile.*getter blew up/);
});

test('a duplicate id cannot be smuggled past by an unstable getter', () => {
    const warnings = [];
    const shifty = (first, rest) => {
        let reads = 0;
        return {
            get id() { return ++reads <= 1 ? first : rest; },
            title: 'X', read: () => null, assess: () => null,
        };
    };
    const {components} = discoverComponents(
        [driver('Sloppy', 'cpu', [shifty('cpu', 'other'), shifty('cpu', 'other')])],
        SYSFS, message => warnings.push(message));

    assert.deepEqual(components.map(c => c.id), ['cpu']);
    assert.equal(warnings.length, 1);
});

// Writing a backend is a documented extension point, and nothing tells a
// contributor their component must be an object literal. A class instance keeps
// `read` and `assess` on its prototype, where a spread does not reach them — it
// would pass every check here and then throw on the first poll, forever.
test('a component built from a class keeps its methods', () => {
    class CpuComponent {
        constructor() { this.id = 'cpu:classy'; this.title = 'CPU'; }
        read() { return {mine: true}; }
        assess() { return {level: 'low', summary: 'ok', detail: ''}; }
    }

    const warnings = [];
    const {components} = discoverComponents(
        [{name: 'Classy', category: 'cpu', discover: () => [new CpuComponent()]}],
        SYSFS, message => warnings.push(message));

    assert.deepEqual(warnings, []);
    assert.equal(typeof components[0].read, 'function');
    assert.deepEqual(components[0].read(), {mine: true});
    assert.equal(typeof components[0].assess, 'function');
});

test('a component method still sees its own `this`', () => {
    class GpuComponent {
        constructor() { this.id = 'gpu:classy'; this.title = 'GPU'; this.mhz = 1400; }
        read() { return {currentMhz: this.mhz}; }
        assess(reading) { return {level: 'low', summary: `${reading.currentMhz}`, detail: ''}; }
    }
    const {components} = discoverComponents(
        [driver('Classy', 'gpu', [new GpuComponent()])], SYSFS);

    const reading = components[0].read();
    assert.deepEqual(reading, {currentMhz: 1400});
    assert.equal(components[0].assess(reading, null, {}).summary, '1400');
});

// Discovery vouches for a fixed shape rather than passing a driver's object
// through, which is what makes a component safe to rely on — and is also how a
// projection can be added to an adapter, wired into the Monitor, and silently
// never arrive. throttlePointC did exactly that: every unit test passed and the
// NPU section simply never mentioned the CPU.
test('every optional projection survives, and an absent one stays absent', () => {
    class WithThermal {
        constructor() {
            this.id = 'cpu:t';
            this.title = 'CPU';
            this.tempC = 61;
            this.critC = 100;
        }
        read() { return {}; }
        assess() { return {level: 'low', summary: '', detail: ''}; }
        temperatureC() { return this.tempC; }
        throttlePointC() { return this.critC; }
    }
    const {components} = discoverComponents([
        driver('A', 'cpu', [new WithThermal()]),
        driver('B', 'npu', [component('npu:x')]),
    ], SYSFS);

    assert.equal(components[0].temperatureC(null), 61);
    assert.equal(components[0].throttlePointC(null), 100,
        'a projection on the prototype is reached and keeps its `this`');
    for (const name of ['temperatureC', 'throttlePointC'])
        assert.equal(components[1][name], undefined,
            `a component that offers no ${name} must not appear to`);
});

test('one projection without the other is carried alone', () => {
    // A CPU whose driver publishes no trip point — the thermal-zone path, and
    // every AMD part since Zen — still offers its temperature.
    const {components} = discoverComponents([driver('A', 'cpu', [{
        ...component('cpu:a'), id: 'cpu:a', temperatureC: () => 70,
    }])], SYSFS);
    assert.equal(components[0].temperatureC(null), 70);
    assert.equal(components[0].throttlePointC, undefined);
});

test('the component handed on is frozen and carries nothing extra', () => {
    const {components} = discoverComponents(
        [driver('A', 'cpu', [{...component('cpu:a'), secret: 'x', id: 'cpu:a'}])], SYSFS);

    assert.ok(Object.isFrozen(components[0]));
    assert.deepEqual(Object.keys(components[0]).sort(), ['assess', 'id', 'read', 'title']);
});

test('a component missing a title or with a non-function read is refused', () => {
    const warnings = [];
    const bad = [
        {id: 'a', read: () => null, assess: () => null},
        {id: 'b', title: 7, read: () => null, assess: () => null},
        {id: 'c', title: 'C', read: 'not a function', assess: () => null},
        {id: 'd', title: 'D', read: () => null},
    ];
    const {components} = discoverComponents(
        [driver('Sloppy', 'cpu', bad)], SYSFS, message => warnings.push(message));

    assert.deepEqual(components, []);
    assert.equal(warnings.length, bad.length);
});
