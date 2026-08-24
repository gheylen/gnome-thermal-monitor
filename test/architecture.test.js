// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The architecture rules are only worth anything if they fire.
//
// `eslint.config.js` expresses the dependency rule from docs/ARCHITECTURE.md as
// `no-restricted-imports` groups. A pattern that matches nothing lints clean —
// it does not announce itself — so the layering can silently stop being
// enforced while four documents go on claiming that it is. (This happened:
// `resource://*` never matched, because `*` does not cross a `/`.)
//
// So: lint a synthetic source in each layer and require the violation to be
// reported. These tests fail when a rule stops working, not when it works.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {ESLint} from 'eslint';

const eslint = new ESLint({cwd: new URL('..', import.meta.url).pathname});

/**
 * Lint `source` as if it were at `filePath`, and return the rule ids reported.
 *
 * @param {string} filePath  Repo-relative; decides which config blocks apply.
 * @param {string} source
 * @returns {Promise<string[]>}
 */
async function lint(filePath, source) {
    const [result] = await eslint.lintText(source, {filePath, warnIgnored: false});
    return result.messages.map(message => message.ruleId);
}

const RESTRICTED = 'no-restricted-imports';
const importing = specifier => `import X from '${specifier}';\nexport default X;\n`;

// ── The dependency rule ────────────────────────────────────────────────────

const RUNTIME_IS_REFUSED = [
    ['src/domain/probe.js', 'gi://Gio'],
    ['src/domain/probe.js', 'resource:///org/gnome/shell/ui/main.js'],
    ['src/hardware/probe.js', 'gi://Gio'],
    ['src/hardware/probe.js', 'resource:///org/gnome/shell/ui/main.js'],
    ['src/sysfs/port.js', 'gi://Gio'],
    ['src/presentation.js', 'gi://St'],
    ['src/presentation.js', 'resource:///org/gnome/shell/ui/main.js'],
    ['test/probe.test.js', 'gi://Gio'],
    ['test/probe.test.js', 'resource:///org/gnome/shell/ui/main.js'],
];

for (const [filePath, specifier] of RUNTIME_IS_REFUSED) {
    test(`${filePath} may not import ${specifier}`, async () => {
        assert.ok((await lint(filePath, importing(specifier))).includes(RESTRICTED));
    });
}

const CONCRETE_IS_REFUSED = [
    ['src/domain/probe.js', '../sysfs/gio.js'],
    ['src/domain/probe.js', '../hardware/index.js'],
    ['src/domain/probe.js', '../presentation.js'],
    ['src/hardware/probe.js', '../sysfs/gio.js'],
    ['src/hardware/probe.js', '../presentation.js'],
    // Presentation words a Verdict. Reaching a driver or the Gio adapter would
    // put GJS in the import graph of a module the Node suite loads directly.
    ['src/presentation.js', './sysfs/gio.js'],
    ['src/presentation.js', './sysfs/port.js'],
    ['src/presentation.js', './hardware/index.js'],
    // The two leaves. Every layer is written against the port and may call the
    // log, so neither may depend on a layer in turn.
    ['src/sysfs/port.js', '../domain/confidence.js'],
    ['src/sysfs/port.js', '../hardware/index.js'],
    ['src/sysfs/port.js', '../presentation.js'],
    ['src/log.js', './domain/confidence.js'],
    ['src/log.js', './hardware/index.js'],
    ['src/log.js', './sysfs/port.js'],
    ['src/log.js', './presentation.js'],
    // Dependencies point inwards, so no layer may reach an entry point. Both
    // hold something a layer would like — `extension.js` the live settings,
    // `prefs.js` the bounds its spin rows use — and importing either would put
    // St or Adw in the graph of a module the Node suite loads directly.
    ['src/domain/probe.js', '../../extension.js'],
    ['src/domain/probe.js', '../../prefs.js'],
    ['src/hardware/probe.js', '../../extension.js'],
    ['src/presentation.js', './../extension.js'],
    ['src/sysfs/port.js', '../../prefs.js'],
    ['src/log.js', '../extension.js'],
];

for (const [filePath, specifier] of CONCRETE_IS_REFUSED) {
    test(`${filePath} may not import ${specifier}`, async () => {
        assert.ok((await lint(filePath, importing(specifier))).includes(RESTRICTED));
    });
}

// ── The two entry points live in different processes ───────────────────────

const WRONG_TOOLKIT = [
    ['extension.js', 'gi://Gtk'],
    ['extension.js', 'gi://Adw'],
    ['extension.js', 'gi://Gdk'],
    // The extensions application's own modules, which live at a *different*
    // resource path from the shell's — note the capital S, which a glob is
    // case-sensitive about.
    ['extension.js', 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'],
    ['prefs.js', 'gi://St'],
    ['prefs.js', 'gi://Clutter'],
    ['prefs.js', 'gi://Meta'],
    ['prefs.js', 'gi://Shell'],
    ['prefs.js', 'resource:///org/gnome/shell/ui/main.js'],
];

for (const [filePath, specifier] of WRONG_TOOLKIT) {
    test(`${filePath} may not import ${specifier}`, async () => {
        assert.ok((await lint(filePath, importing(specifier))).includes(RESTRICTED));
    });
}

// ── The logging port ───────────────────────────────────────────────────────

test('only src/log.js may write to the journal', async () => {
    const logging = 'export const shout = () => console.warn("x");\n';
    assert.ok((await lint('src/domain/probe.js', logging)).includes('no-console'));
    assert.ok((await lint('src/hardware/probe.js', logging)).includes('no-console'));
    assert.ok(!(await lint('src/log.js', logging)).includes('no-console'));
});

// ── The rules must not be so broad that legitimate code trips them ─────────

test('the layers can still import what they are supposed to', async () => {
    const allowed = [
        ['src/domain/probe.js', './confidence.js'],
        ['src/hardware/probe.js', '../domain/cpu.js'],
        ['src/hardware/probe.js', '../sysfs/port.js'],
        ['src/presentation.js', './domain/confidence.js'],
        ['src/presentation.js', './domain/monitor.js'],
        ['src/sysfs/gio.js', 'gi://Gio'],
        ['extension.js', 'gi://St'],
        ['extension.js', 'resource:///org/gnome/shell/ui/main.js'],
        ['prefs.js', 'gi://Adw'],
        ['prefs.js', 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'],
        ['test/probe.test.js', '../src/domain/cpu.js'],
    ];
    for (const [filePath, specifier] of allowed) {
        const reported = await lint(filePath, importing(specifier));
        assert.ok(!reported.includes(RESTRICTED),
            `${filePath} should be allowed to import ${specifier}`);
    }
});

// ── The engine the extension actually runs on ──────────────────────────────
//
// metadata.json claims GNOME Shell 46, which ships GJS 1.80 on SpiderMonkey
// 115 — SpiderMonkey 128 did not arrive until GJS 1.81.2, in the 47 cycle. Node
// 22 is several releases past 115, and so is the `gjs` on a developer's machine
// — so a built-in that works everywhere here can be missing on the oldest shell
// this extension says it supports, where the symptom is an extension that will
// not enable.

test('a built-in newer than the shell-version floor is refused in shipped code', async () => {
    const cases = [
        'export const g = Object.groupBy([], x => x);',
        'export const g = Map.groupBy([], x => x);',
        'export const a = Array.fromAsync([]);',
        'export const p = Promise.withResolvers();',
    ];
    for (const source of cases)
        for (const filePath of ['src/domain/probe.js', 'extension.js', 'prefs.js'])
            assert.ok((await lint(filePath, source)).includes('no-restricted-properties'),
                `${filePath}: ${source}`);
});

test('syntax newer than the shell-version floor is refused in shipped code', async () => {
    // The RegExp `v` flag is ES2024 syntax and SpiderMonkey 117, so it parses
    // under Node and under a current gjs and fails on the floor. Nothing in a
    // rule list can catch syntax; only the parser level can, which is why
    // shipped code is parsed at ES2022 and the test suite is not.
    const vFlag = 'export const re = /[\\p{ASCII}--[a-z]]/v;\n';
    for (const filePath of ['src/domain/probe.js', 'extension.js', 'prefs.js']) {
        const reported = await lint(filePath, vFlag);
        assert.ok(reported.length > 0, `${filePath} should refuse the v flag`);
    }
    assert.deepEqual(await lint('test/probe.test.js', vFlag), [],
        'and the test suite, which runs under Node, should not');
});

test('the test suite is not held to the extension floor', async () => {
    // Tests run under Node, never in the shell. Holding them to SpiderMonkey
    // 115 would be a restriction that buys nothing and costs clarity.
    const source = 'export const g = Object.groupBy([], x => x);';
    assert.ok(!(await lint('test/probe.test.js', source)).includes('no-restricted-properties'));
});

// ── A GJS footgun that cost the popup menu and the panel container ─────────

test('extension.js may not define a method called _onDestroy', async () => {
    // PanelMenu.ButtonBox binds `this._onDestroy` at construction; the lookup
    // finds the most derived definition, so a subclass method by that name
    // replaces the shell's teardown silently. Nothing about it looks wrong.
    const shadowing = 'class X { _onDestroy() { this.cleanup(); } }\n';
    assert.ok((await lint('extension.js', shadowing)).includes('no-restricted-syntax'));
});

test('any other cleanup method name is fine', async () => {
    const fine = 'class X { _stopWork() { this.cleanup(); } }\n';
    assert.ok(!(await lint('extension.js', fine)).includes('no-restricted-syntax'));
});

test('the _onDestroy refusal covers the computed-key spelling too', async () => {
    // `['_onDestroy']() {}` shadows the base handler exactly as the plain form
    // does — confirmed under GJS against the real class shape.
    const computed = "class X { ['_onDestroy']() { this.cleanup(); } }\n";
    assert.ok((await lint('extension.js', computed)).includes('no-restricted-syntax'));
});

test('a class field or constructor assignment is not refused', async () => {
    // These run after super() has bound the prototype method, so they do not
    // shadow it; refusing them would be noise.
    const field = 'class X { _onDestroy = () => this.cleanup(); }\n';
    assert.ok(!(await lint('extension.js', field)).includes('no-restricted-syntax'));
});
