// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Lint configuration.  Beyond the usual correctness rules, this file makes the
// architecture machine-checked: the layering described in docs/ARCHITECTURE.md
// is expressed here as import restrictions, so a violation fails CI instead of
// waiting for a reviewer to notice it.

import js from '@eslint/js';

/** Globals GJS provides that neither Node nor a browser does. */
const GJS_GLOBALS = {
    console: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

/** Globals the GJS command-line runtime adds on top. */
const GJS_SCRIPT_GLOBALS = {
    ...GJS_GLOBALS,
    print: 'readonly',
    printerr: 'readonly',
    log: 'readonly',
    logError: 'readonly',
};

/** The subset of Node's globals the test suite actually uses. */
const NODE_GLOBALS = {
    console: 'readonly',
    process: 'readonly',
    URL: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    structuredClone: 'readonly',
};

// Anything that would drag a runtime into a layer that must stay portable.
// `*` does not cross a `/` in these patterns, so a resource URI — which has a
// path — needs `**`. `resource://*` silently matches nothing.
const RUNTIME_IMPORTS = ['gi://*', 'resource://**'];

/**
 * Built-ins that postdate SpiderMonkey 115, which is what GNOME Shell 46 ships.
 *
 * Node 22 has all of them, so nothing else in this repository would notice one
 * being used. Extend the list when a newer one becomes tempting; shorten it by
 * raising `metadata.json`'s shell-version floor.
 */
const TOO_NEW_FOR_THE_FLOOR = [
    ['Object', 'groupBy', 117],
    ['Map', 'groupBy', 117],
    ['Array', 'fromAsync', 117],
    ['Promise', 'withResolvers', 119],
    ['Promise', 'try', 134],
].map(([object, property, since]) => ({
    object,
    property,
    message: `${object}.${property}() needs SpiderMonkey ${since}; GNOME Shell 46 ships 115. ` +
        'Write it out, or raise the shell-version floor in metadata.json.',
}));

const restrict = (patterns, message) => ({
    'no-restricted-imports': ['error', {patterns: [{group: patterns, message}]}],
});

export default [
    {ignores: ['node_modules/', 'dist/']},

    js.configs.recommended,

    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: GJS_GLOBALS,
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error',
        },
        rules: {
            'no-var': 'error',
            'prefer-const': 'error',
            'eqeqeq': ['error', 'always'],
            'object-shorthand': ['error', 'always'],
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },

    // ── The engine the extension actually runs on ──────────────────────────
    //
    // `metadata.json` declares GNOME Shell 46 as the floor, and GNOME 46 ships
    // GJS 1.80 on SpiderMonkey 115 — SpiderMonkey 128 did not arrive until GJS
    // 1.81.2, in the 47 cycle. Node 22 is several releases ahead of that,
    // so a built-in that is ordinary here can be absent there — and the failure
    // is an extension that will not enable, on the oldest shell we claim to
    // support, which is the hardest place to notice it.
    //
    // The GJS test is the real evidence, but it runs on whatever `gjs` is
    // installed, which on a developer's machine is newer. This list is what
    // holds the declared floor to something checkable.
    {
        files: ['extension.js', 'prefs.js', 'src/**/*.js'],
        languageOptions: {
            // Refuses syntax newer than SpiderMonkey 115: import attributes,
            // `using` declarations, and whatever comes next.
            ecmaVersion: 2022,
        },
        rules: {
            'no-restricted-properties': ['error', ...TOO_NEW_FOR_THE_FLOOR],
        },
    },

    // ── The dependency rule, enforced ──────────────────────────────────────

    {
        files: ['src/domain/**/*.js'],
        rules: restrict(
            [...RUNTIME_IMPORTS, '**/sysfs/gio.js', '**/hardware/**', '**/presentation.js'],
            'The domain must not depend on a runtime, a driver, or the UI. ' +
            'Reach the kernel through the Sysfs port that is passed in.'),
    },
    {
        files: ['src/hardware/**/*.js'],
        rules: restrict(
            [...RUNTIME_IMPORTS, '**/sysfs/gio.js', '**/presentation.js'],
            'A hardware adapter talks to the injected Sysfs port, never to a runtime ' +
            'or a concrete adapter, and never to the UI.'),
    },
    {
        // The port is the innermost module in the tree: it defines the contract
        // the layers above depend on, so it may depend on none of them.
        files: ['src/sysfs/port.js'],
        rules: restrict(
            [...RUNTIME_IMPORTS, '**/domain/**', '**/hardware/**', '**/presentation.js'],
            'src/sysfs/port.js is the contract every other layer is written ' +
            'against. It depends on nothing.'),
    },
    {
        // Presentation words what the domain decided.  It has no business
        // knowing which driver produced a verdict or how sysfs was read.
        files: ['src/presentation.js'],
        rules: restrict(
            [...RUNTIME_IMPORTS, '**/sysfs/**', '**/hardware/**'],
            'src/presentation.js turns a Verdict into words. It may read the ' +
            'domain vocabulary and nothing else — importing a driver or the ' +
            'Gio adapter would drag GJS into a module the tests run under Node.'),
    },
    {
        // The logging port is a leaf too: everything may call it, so anything
        // it imported would end up in every layer's dependency graph.
        files: ['src/log.js'],
        rules: restrict(
            [...RUNTIME_IMPORTS, '**/domain/**', '**/hardware/**', '**/sysfs/**',
                '**/presentation.js'],
            'src/log.js is a leaf. Every layer may call it, so it may call none of them.'),
    },

    // GNOME Shell and the preferences window are separate processes with
    // separate toolkits.  Importing the wrong one is a review rejection at best
    // and a crash at worst, so neither entry point may reach for the other's.
    {
        files: ['extension.js'],
        rules: {
            ...restrict(
                ['gi://Gtk', 'gi://Adw', 'gi://Gdk', '**/Shell/Extensions/js/**'],
                'extension.js runs inside gnome-shell: GTK, the preferences ' +
                'libraries and the extensions application\'s own modules all ' +
                'belong to prefs.js.'),
            // PanelMenu.ButtonBox binds `this._onDestroy` at construction, and
            // that lookup finds the most derived definition.  A subclass method
            // by that name therefore replaces the shell's own teardown — which
            // is what destroys the popup menu (parented to Main.uiGroup, not to
            // the button) and the panel container — with no error and no sign.
            'no-restricted-syntax': ['error', {
                // Both spellings: `_onDestroy() {}` and `['_onDestroy']() {}`.
                // A class field or a constructor assignment is harmless — those
                // run after super() has already bound the prototype method.
                selector: "MethodDefinition[key.name='_onDestroy'], " +
                    "MethodDefinition[key.value='_onDestroy']",
                message: 'Naming a method _onDestroy silently replaces ' +
                    'PanelMenu.ButtonBox\'s own destroy handler, leaking the ' +
                    'menu and the panel container. Use a different name and ' +
                    "connect it yourself with this.connect('destroy', …).",
            }],
        },
    },
    {
        files: ['prefs.js'],
        rules: restrict(['gi://St', 'gi://Clutter', 'gi://Meta', 'gi://Shell', '**/shell/ui/**'],
            'prefs.js runs in the extensions application: the Shell toolkit is ' +
            'not available there.'),
    },

    // Only the logging port may reach the journal directly.
    {
        files: ['src/**/*.js'],
        ignores: ['src/log.js'],
        rules: {'no-console': 'error'},
    },

    // ── Build tooling ──────────────────────────────────────────────────────

    // Node scripts that run at build time and never ship.
    {
        files: ['tools/**/*.mjs', 'eslint.config.js'],
        languageOptions: {globals: NODE_GLOBALS},
    },

    // ── Test suite ─────────────────────────────────────────────────────────

    {
        files: ['test/**/*.js'],
        languageOptions: {globals: NODE_GLOBALS},
        rules: restrict(RUNTIME_IMPORTS,
            'Node tests cannot load a GJS runtime; test the Gio adapter under test/gjs/.'),
    },
    {
        // Keyed on the suffix, not the directory: `.gjs.js` is what this
        // repository uses to mean "runs under gjs", and a suite that lives
        // somewhere else — `test/prefs/` needs a display, so it cannot sit
        // beside the ones `make test-gjs` globs — is still one of these.
        // `test/gjs/harness.js` is named for import rather than execution and
        // is listed alongside.
        files: ['test/**/*.gjs.js', 'test/gjs/**/*.js'],
        languageOptions: {globals: GJS_SCRIPT_GLOBALS},
        rules: {'no-restricted-imports': 'off'},
    },
];
