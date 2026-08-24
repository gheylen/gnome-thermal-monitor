// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The Monitor aggregate — every decision the panel used to make inline.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {Confidence} from '../../src/domain/confidence.js';
import {LINGER_MS, Monitor} from '../../src/domain/monitor.js';
import {Thresholds} from '../../src/domain/thresholds.js';

const THRESHOLDS = new Thresholds(88, 94);

/** A component whose readings and verdicts are scripted by the test. */
function stub(id, {readings = [], verdict, title = id, temperatureC, throttlePointC} = {}) {
    const seen = [];
    let poll = 0;
    return {
        component: {
            id,
            title,
            read: () => readings[Math.min(poll++, readings.length - 1)] ?? null,
            assess: (reading, previous, context) => {
                seen.push({reading, previous, context});
                return typeof verdict === 'function'
                    ? verdict(reading, previous, context)
                    : {level: Confidence.LOW, summary: 'ok', detail: '', ...verdict};
            },
            ...(temperatureC ? {temperatureC} : {}),
            ...(throttlePointC ? {throttlePointC} : {}),
        },
        seen,
    };
}

const level = value => ({level: value, summary: value, detail: ''});

/** A controllable clock, so linger is tested by arithmetic rather than by waiting. */
function clock(start = 1000) {
    let value = start;
    return {now: () => value, advance: ms => { value += ms; }};
}

/**
 * A Monitor with a clock supplied.
 *
 * The aggregate requires one and has no default, because the only clock that
 * works is a monotonic one and `Date.now` sitting there as a fallback would
 * silently reinstate a fixed bug. Most tests here do not care what time it is,
 * so they get a still one; the tests that are about the linger pass their own.
 */
const monitorOf = (components, options = {}) =>
    new Monitor(components, {now: () => 0, ...options});

// The linger used to run on the wall clock, and a jump across suspend/resume
// held the panel red indefinitely. Injecting a monotonic clock fixed it — but a
// `now = Date.now` default would have put the bug one forgotten argument away,
// which is not a thing this aggregate should be able to do quietly.
test('a Monitor cannot be built without a clock', () => {
    for (const options of [undefined, {}, {lingerMs: 1000}, {now: 0}, {now: null}])
        assert.throws(() => new Monitor([], options), TypeError,
            `for ${JSON.stringify(options)}`);
});

test('the thresholds a rule sees are ordered, however the settings arrived', () => {
    const cpu = stub('cpu', {readings: [{}]});
    monitorOf([cpu.component]).poll(new Thresholds(94, 88));
    assert.equal(cpu.seen[0].context.thresholds.warnC, 88);
    assert.equal(cpu.seen[0].context.thresholds.critC, 94);
});

test('a monitor with no components reports UNKNOWN rather than "all clear"', () => {
    const snapshot = monitorOf([]).poll(THRESHOLDS);
    assert.equal(snapshot.level, Confidence.UNKNOWN);
    assert.equal(snapshot.temperatureC, null);
    assert.deepEqual(snapshot.components, []);
    assert.equal(snapshot.throttlingCount, null);
});

test('the panel level is the worst across components', () => {
    const monitor = monitorOf([
        stub('a', {verdict: level(Confidence.IDLE)}).component,
        stub('b', {verdict: level(Confidence.MEDIUM)}).component,
        stub('c', {verdict: level(Confidence.LOW)}).component,
    ]);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.MEDIUM);
});

test('each component keeps its own identity, title and verdict in the snapshot', () => {
    const monitor = monitorOf([
        stub('cpu:intel', {title: 'CPU', verdict: {level: Confidence.HIGH, summary: '92°C', detail: 'hot'}}).component,
    ]);
    assert.deepEqual(monitor.poll(THRESHOLDS).components, [
        {id: 'cpu:intel', title: 'CPU', level: Confidence.HIGH, summary: '92°C', detail: 'hot'},
    ]);
});

test('normalised thresholds and the shared package temperature reach every rule', () => {
    const cpu = stub('cpu', {readings: [{t: 91}], temperatureC: reading => reading.t});
    const gpu = stub('gpu');
    monitorOf([cpu.component, gpu.component]).poll(new Thresholds(94, 88));
    assert.deepEqual(gpu.seen[0].context, {
        packageTempC: 91,
        packageThrottlePointC: null,
        thresholds: new Thresholds(88, 94),
    });
});

test('the trip point comes from the same component as the temperature', () => {
    // A temperature from one sensor and a TjMax from another would produce a
    // headroom describing no hardware at all, so the projection is only
    // consulted on the component that supplied the temperature.
    const cool = stub('cool', {
        readings: [{t: null, crit: 85}],
        temperatureC: reading => reading.t,
        throttlePointC: reading => reading.crit,
    });
    const hot = stub('hot', {
        readings: [{t: 91, crit: 100}],
        temperatureC: reading => reading.t,
        throttlePointC: reading => reading.crit,
    });
    const gpu = stub('gpu');
    monitorOf([cool.component, hot.component, gpu.component]).poll(THRESHOLDS);
    const {packageTempC, packageThrottlePointC} = gpu.seen[0].context;
    assert.deepEqual([packageTempC, packageThrottlePointC], [91, 100],
        'the first component with a temperature supplies both, or neither');
});

test('a component offering a temperature but no trip point still shares the temperature', () => {
    const cpu = stub('cpu', {readings: [{t: 70}], temperatureC: reading => reading.t});
    const gpu = stub('gpu');
    monitorOf([cpu.component, gpu.component]).poll(THRESHOLDS);
    assert.equal(gpu.seen[0].context.packageTempC, 70);
    assert.equal(gpu.seen[0].context.packageThrottlePointC, null);
});

test('the package temperature is collected before any rule runs, whatever the order', () => {
    // The GPU rule needs the CPU temperature even though the GPU is assessed first.
    const gpu = stub('gpu');
    const cpu = stub('cpu', {readings: [{t: 77}], temperatureC: reading => reading.t});
    monitorOf([gpu.component, cpu.component]).poll(THRESHOLDS);
    assert.equal(gpu.seen[0].context.packageTempC, 77);
});

test('the first component offering a temperature wins', () => {
    const first = stub('a', {readings: [{t: null}], temperatureC: reading => reading.t});
    const second = stub('b', {readings: [{t: 60}], temperatureC: reading => reading.t});
    const third = stub('c', {readings: [{t: 99}], temperatureC: reading => reading.t});
    const snapshot = monitorOf([first.component, second.component, third.component]).poll(THRESHOLDS);
    assert.equal(snapshot.temperatureC, 60, 'a null offer is skipped, later offers are not');
});

test('the previous reading is the one from the poll before, not from this poll', () => {
    const cpu = stub('cpu', {readings: [{n: 1}, {n: 2}, {n: 3}]});
    const monitor = monitorOf([cpu.component]);
    monitor.poll(THRESHOLDS);
    monitor.poll(THRESHOLDS);
    monitor.poll(THRESHOLDS);
    assert.deepEqual(cpu.seen.map(call => [call.previous, call.reading]),
        [[undefined, {n: 1}], [{n: 1}, {n: 2}], [{n: 2}, {n: 3}]]);
});

test('every rule sees the same previous-poll window, even mid-pass', () => {
    // Advancing the window per component would let a later rule see this poll's
    // reading as "previous". Both must still see poll 1's reading on poll 2.
    const a = stub('a', {readings: [{n: 1}, {n: 2}]});
    const b = stub('b', {readings: [{n: 10}, {n: 20}]});
    const monitor = monitorOf([a.component, b.component]);
    monitor.poll(THRESHOLDS);
    monitor.poll(THRESHOLDS);
    assert.deepEqual(a.seen[1].previous, {n: 1});
    assert.deepEqual(b.seen[1].previous, {n: 10});
});

test('a panel suffix is picked up from whichever component offers one', () => {
    const monitor = monitorOf([
        stub('a').component,
        stub('b', {verdict: {...level(Confidence.CONFIRMED), throttlingCount: 3}}).component,
    ]);
    assert.equal(monitor.poll(THRESHOLDS).throttlingCount, 3);
});

// "3" beside the temperature reads as "three cores are throttling", which is a
// claim only a hardware counter earns. A rule that attached a count to a lesser
// verdict would put that claim on the panel without the evidence behind it, so
// the Snapshot takes one only from a component that is CONFIRMED.
test('a count on a verdict short of CONFIRMED never reaches the panel', () => {
    for (const notConfirmed of [Confidence.HIGH, Confidence.MEDIUM, Confidence.LOW]) {
        const monitor = monitorOf([
            stub('a', {verdict: {...level(notConfirmed), throttlingCount: 7}}).component,
        ]);
        assert.equal(monitor.poll(THRESHOLDS).throttlingCount, null, notConfirmed);
    }
});

test('the confirmed component supplies the count, not whichever comes first', () => {
    const monitor = monitorOf([
        stub('a', {verdict: {...level(Confidence.MEDIUM), throttlingCount: 7}}).component,
        stub('b', {verdict: {...level(Confidence.CONFIRMED), throttlingCount: 2}}).component,
    ]);
    assert.equal(monitor.poll(THRESHOLDS).throttlingCount, 2);
});

// The linger holds the panel red after the burst ends. Nothing is throttling by
// then, so there is no honest number to put beside the temperature.
test('the count goes with the throttle, not with the linger', () => {
    const time = clock();
    let throttling = true;
    const monitor = monitorOf([
        stub('a', {verdict: () => throttling
            ? {...level(Confidence.CONFIRMED), throttlingCount: 4}
            : level(Confidence.LOW)}).component,
    ], time);

    assert.equal(monitor.poll(THRESHOLDS).throttlingCount, 4);

    throttling = false;
    time.advance(1000);
    const lingering = monitor.poll(THRESHOLDS);
    assert.equal(lingering.level, Confidence.CONFIRMED, 'still red');
    assert.equal(lingering.throttlingCount, null, 'but nothing is throttling now');
});

// ── Linger ────────────────────────────────────────────────────────────────

test('a confirmed throttle holds the panel red for the linger window', () => {
    const time = clock();
    let throttling = true;
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(throttling ? Confidence.CONFIRMED : Confidence.LOW)}).component],
        {now: time.now});

    const first = monitor.poll(THRESHOLDS);
    assert.equal(first.level, Confidence.CONFIRMED);
    assert.equal(first.lingerUntilMs, 1000 + LINGER_MS);

    throttling = false;
    time.advance(LINGER_MS - 1);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.CONFIRMED, 'still lingering');

    time.advance(1);
    const expired = monitor.poll(THRESHOLDS);
    assert.equal(expired.level, Confidence.LOW);
    assert.equal(expired.lingerUntilMs, null);
});

test('a fresh throttle event extends the linger window', () => {
    const time = clock();
    const monitor = monitorOf(
        [stub('cpu', {verdict: level(Confidence.CONFIRMED)}).component],
        {now: time.now, lingerMs: 100});
    monitor.poll(THRESHOLDS);
    time.advance(50);
    assert.equal(monitor.poll(THRESHOLDS).lingerUntilMs, 1050 + 100);
});

test('the linger window is configurable and honoured to the millisecond', () => {
    const time = clock();
    let throttling = true;
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(throttling ? Confidence.CONFIRMED : Confidence.LOW)}).component],
        {now: time.now, lingerMs: 250});

    assert.equal(monitor.poll(THRESHOLDS).lingerUntilMs, 1250, 'the configured window, not the default');

    throttling = false;
    time.advance(249);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.CONFIRMED, 'one millisecond short');
    time.advance(1);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.LOW, 'exactly at the deadline');
});

test('a calm poll never opens a linger window', () => {
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(Confidence.LOW)}).component],
        {now: clock().now, lingerMs: 250});
    assert.equal(monitor.poll(THRESHOLDS).lingerUntilMs, null);
});

// ── Notification edge ─────────────────────────────────────────────────────

test('the throttle notification fires on the edge in, once per burst', () => {
    const time = clock();
    let throttling = false;
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(throttling ? Confidence.CONFIRMED : Confidence.LOW)}).component],
        {now: time.now, lingerMs: 10});

    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, false);

    throttling = true;
    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, true, 'the edge in');
    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, false, 'still throttling, not a new burst');

    throttling = false;
    time.advance(20);
    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, false, 'the edge out');

    throttling = true;
    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, true, 'a genuinely new burst');
});

test('the linger keeps a flickering throttle from re-notifying', () => {
    const time = clock();
    let throttling = true;
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(throttling ? Confidence.CONFIRMED : Confidence.LOW)}).component],
        {now: time.now, lingerMs: 1000});

    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, true);
    for (let i = 0; i < 5; i++) {
        throttling = !throttling;
        time.advance(10);
        assert.equal(monitor.poll(THRESHOLDS).throttleStarted, false);
    }
});

// ── Fault isolation ───────────────────────────────────────────────────────

test('a component that throws while reading costs only itself', () => {
    const errors = [];
    const exploding = {
        id: 'bad', title: 'Bad',
        read() { throw new Error('sysfs went away'); },
        assess: reading => reading === null
            ? level(Confidence.UNKNOWN)
            : level(Confidence.CONFIRMED),
    };
    const monitor = monitorOf([exploding, stub('good', {verdict: level(Confidence.MEDIUM)}).component],
        {onError: (id, error) => errors.push([id, String(error)])});

    const snapshot = monitor.poll(THRESHOLDS);
    assert.equal(snapshot.level, Confidence.MEDIUM);
    assert.equal(snapshot.components[0].level, Confidence.UNKNOWN);
    assert.deepEqual(errors.map(([id]) => id), ['bad']);
});

test('a component that throws while assessing degrades to UNKNOWN', () => {
    const errors = [];
    const exploding = {
        id: 'bad', title: 'Bad',
        read: () => ({}),
        assess() { throw new Error('bad rule'); },
    };
    const snapshot = monitorOf([exploding], {onError: (id, error) => errors.push([id, error])})
        .poll(THRESHOLDS);
    assert.equal(snapshot.components[0].level, Confidence.UNKNOWN);
    assert.match(snapshot.components[0].detail, /failed/i);
    assert.equal(errors.length, 1);
});

test('a temperature projection that throws does not stop the poll', () => {
    const errors = [];
    const monitor = monitorOf([{
        id: 'cpu', title: 'CPU',
        read: () => ({}),
        assess: () => level(Confidence.LOW),
        temperatureC() { throw new Error('nope'); },
    }], {onError: id => errors.push(id)});
    assert.equal(monitor.poll(THRESHOLDS).temperatureC, null);
    assert.equal(errors.length, 1);
});

test('a monitor without an error sink still survives a throwing component', () => {
    const monitor = monitorOf([{
        id: 'bad', title: 'Bad',
        read() { throw new Error('boom'); },
        assess: () => level(Confidence.UNKNOWN),
    }]);
    assert.equal(monitor.poll(THRESHOLDS).level, Confidence.UNKNOWN);
});

test('the component list is exposed for menu construction and cannot be swapped underneath', () => {
    const components = [stub('a').component];
    const monitor = monitorOf(components);
    components.push(stub('b').component);
    assert.deepEqual(monitor.components.map(component => component.id), ['a']);
});

test('a rule that answers with nothing at all is treated as a broken rule', () => {
    const errors = [];
    for (const answer of [undefined, null, 'confirmed', 42, {summary: 'no level'}]) {
        const snapshot = monitorOf([{
            id: 'bad', title: 'Bad', read: () => ({}), assess: () => answer,
        }], {onError: (id, error) => errors.push(error)}).poll(THRESHOLDS);
        assert.equal(snapshot.components[0].level, Confidence.UNKNOWN, `for ${String(answer)}`);
        assert.match(snapshot.components[0].detail, /failed/i);
    }
    assert.equal(errors.length, 5);
    assert.ok(errors.every(error => error instanceof TypeError));
});

test('the exposed component list is frozen', () => {
    const monitor = monitorOf([stub('a').component]);
    assert.ok(Object.isFrozen(monitor.components));
});

// ── Reassessment ──────────────────────────────────────────────────────────

// Thresholds come from GSettings, and a settings write arrives on every step of
// a spin button. Re-polling for each one would read all of sysfs inside the
// compositor and chop the PROCHOT delta window into slivers a burst can hide
// between — so a threshold change re-answers the last poll instead.

test('reassessment before the first poll has nothing to answer with', () => {
    assert.equal(monitorOf([stub('a').component]).reassess(THRESHOLDS), null);
});

test('reassessment does not touch the hardware', () => {
    let reads = 0;
    const monitor = monitorOf([{
        id: 'cpu', title: 'CPU',
        read: () => { reads++; return {}; },
        assess: () => level(Confidence.LOW),
    }]);
    monitor.poll(THRESHOLDS);
    assert.equal(reads, 1);
    monitor.reassess(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    assert.equal(reads, 1, 'no further reads');
});

test('reassessment answers the new thresholds against the last reading', () => {
    const cpu = stub('cpu', {
        readings: [{tempC: 90}],
        temperatureC: reading => reading.tempC,
        verdict: (reading, previous, context) =>
            level(context.thresholds.isCritical(reading.tempC) ? Confidence.HIGH : Confidence.MEDIUM),
    });
    const monitor = monitorOf([cpu.component]);

    assert.equal(monitor.poll(new Thresholds(88, 94)).level, Confidence.MEDIUM);
    assert.equal(monitor.reassess(new Thresholds(80, 85)).level, Confidence.HIGH);
    assert.equal(monitor.reassess(new Thresholds(88, 94)).level, Confidence.MEDIUM);
});

test('reassessment shows the rules the same previous reading the poll did', () => {
    const cpu = stub('cpu', {readings: [{n: 1}, {n: 2}]});
    const monitor = monitorOf([cpu.component]);
    monitor.poll(THRESHOLDS);
    monitor.poll(THRESHOLDS);
    monitor.reassess(THRESHOLDS);

    const [, second, reassessed] = cpu.seen;
    assert.deepEqual(reassessed.reading, second.reading);
    assert.deepEqual(reassessed.previous, second.previous,
        'not the reading from the poll being reassessed');
});

test('reassessment does not advance the delta window', () => {
    const cpu = stub('cpu', {readings: [{n: 1}, {n: 2}]});
    const monitor = monitorOf([cpu.component]);
    monitor.poll(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    monitor.poll(THRESHOLDS);

    assert.deepEqual(cpu.seen.at(-1).previous, {n: 1},
        'the next real poll still diffs against the last real poll');
});

test('reassessment never claims a throttle burst has started', () => {
    const time = clock();
    let throttling = false;
    const monitor = monitorOf(
        [stub('cpu', {verdict: () => level(throttling ? Confidence.CONFIRMED : Confidence.LOW)}).component],
        {now: time.now, lingerMs: 1000});

    monitor.poll(THRESHOLDS);
    throttling = true;
    assert.equal(monitor.poll(THRESHOLDS).throttleStarted, true);

    // A settings write must not be able to re-fire a desktop notification.
    assert.equal(monitor.reassess(THRESHOLDS).throttleStarted, false);
    assert.equal(monitor.reassess(THRESHOLDS).throttleStarted, false);
});

test('reassessment neither extends nor expires the linger', () => {
    const time = clock();
    const monitor = monitorOf(
        [stub('cpu', {verdict: level(Confidence.CONFIRMED)}).component],
        {now: time.now, lingerMs: 1000});

    const polled = monitor.poll(THRESHOLDS);
    assert.equal(polled.lingerUntilMs, 2000);

    time.advance(5000);
    const reassessed = monitor.reassess(THRESHOLDS);
    assert.equal(reassessed.lingerUntilMs, 2000, 'the deadline is the poll’s, not now');
    assert.equal(reassessed.level, Confidence.CONFIRMED);
});

test('reassessment orders inverted thresholds just as a poll does', () => {
    const cpu = stub('cpu', {
        readings: [{}],
        verdict: (_reading, _previous, context) =>
            ({...level(Confidence.LOW), detail:
                `${context.thresholds.warnC}/${context.thresholds.critC}`}),
    });
    const monitor = monitorOf([cpu.component]);
    monitor.poll(THRESHOLDS);
    assert.equal(monitor.reassess(new Thresholds(94, 88)).components[0].detail, '88/94');
});

test('reassessment does not re-report a component that already failed', () => {
    // A settings write arrives on every step of a spin button. Repeating the
    // error would put one line in the journal per step, from inside the
    // compositor, for a failure already reported once.
    const errors = [];
    const monitor = monitorOf([{
        id: 'bad', title: 'Bad',
        read: () => ({}),
        assess() { throw new Error('broken rule'); },
    }], {onError: id => errors.push(id)});

    monitor.poll(THRESHOLDS);
    assert.equal(errors.length, 1, 'the poll reports it once');

    monitor.reassess(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    assert.equal(errors.length, 1, 'reassessments stay quiet');

    monitor.poll(THRESHOLDS);
    assert.equal(errors.length, 2, 'the next real poll reports it again');
});

test('a reassessment still degrades a broken component to UNKNOWN', () => {
    // Quiet is not the same as pretending it worked.
    const monitor = monitorOf([{
        id: 'bad', title: 'Bad',
        read: () => ({}),
        assess() { throw new Error('broken rule'); },
    }]);
    monitor.poll(THRESHOLDS);
    const snapshot = monitor.reassess(THRESHOLDS);
    assert.equal(snapshot.components[0].level, Confidence.UNKNOWN);
    assert.match(snapshot.components[0].detail, /failed/i);
});

test('a temperature projection that throws is also reported only on a poll', () => {
    const errors = [];
    const monitor = monitorOf([{
        id: 'cpu', title: 'CPU',
        read: () => ({}),
        assess: () => level(Confidence.LOW),
        temperatureC() { throw new Error('nope'); },
    }], {onError: id => errors.push(id)});

    monitor.poll(THRESHOLDS);
    monitor.reassess(THRESHOLDS);
    assert.equal(errors.length, 1);
});
