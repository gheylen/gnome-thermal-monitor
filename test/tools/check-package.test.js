// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// The packaging check runs against the built zip and nothing else verifies it,
// so a bug here is silent in both directions: it can wave through a package
// missing a module, or — as it once did — reject a sound one over an import
// spelled across several lines.

import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';

import {checkPackage, isRuntimeSpecifier, parseImports} from '../../tools/check-package.mjs';

test('a plain default import is found', () => {
    assert.deepEqual(parseImports("import GLib from 'gi://GLib';\n"), ['gi://GLib']);
});

test('named, namespace, side-effect and re-export forms are all found', () => {
    const source = [
        "import {a, b} from './a.js';",
        "import * as c from './c.js';",
        "import './side-effect.js';",
        "export {d} from './d.js';",
        "export * from './e.js';",
    ].join('\n');
    assert.deepEqual(parseImports(source),
        ['./a.js', './c.js', './side-effect.js', './d.js', './e.js']);
});

test('an import spread across several lines is found', () => {
    // This is ordinary formatting once a module exports more than a few names,
    // and rejecting it failed the build on a package that was sound.
    const source = 'import {\n    one, two,\n    three,\n} from \'./wide.js\';\n';
    assert.deepEqual(parseImports(source), ['./wide.js']);
});

// A comment inside an import list is ordinary, and an earlier version of this
// parser lost the whole statement to one — which is the silent direction: the
// module it named would then look unneeded and be reported missing, or worse,
// left out of the package with nothing to notice.
test('a comment inside an import list does not hide the import', () => {
    const cases = [
        "import {\n    a, // don't remove this one\n} from './bar.js';\n",
        'import {\n    a, // see foo; bar\n} from \'./bar.js\';\n',
        "import {\n    /* it's fine */ a,\n} from './bar.js';\n",
        'import /* why */ a from \'./bar.js\';\n',
        'import a from \'./bar.js\'; // trailing note\n',
    ];
    for (const source of cases)
        assert.deepEqual(parseImports(source), ['./bar.js'], source);
});

// The loud direction: a dependency invented out of prose fails the build with a
// message about a file that was never needed.
test('an import-looking line inside a template literal is not an import', () => {
    const source = 'export const DOC = `\nimport {ghost} from "./ghost.js"\n`;\n';
    assert.deepEqual(parseImports(source), []);
});

test('an import-looking line inside a comment is not an import', () => {
    const source = "// import {ghost} from './ghost.js'\n/*\nimport x from './also-ghost.js';\n*/\n";
    assert.deepEqual(parseImports(source), []);
});

test('a regular expression containing quotes does not derail the scan', () => {
    const source = String.raw`const quoted = /['"]/;` +
        "\nimport real from './real.js';\n";
    assert.deepEqual(parseImports(source), ['./real.js']);
});

test('an escaped quote inside a string does not end it early', () => {
    const source = "export const s = 'it\\'s fine';\nimport real from './real.js';\n";
    assert.deepEqual(parseImports(source), ['./real.js']);
});

test('two imports on one line are both found', () => {
    assert.deepEqual(parseImports("import a from './a.js'; import b from './b.js';\n"),
        ['./a.js', './b.js']);
});

test('double and single quotes are both handled', () => {
    assert.deepEqual(parseImports('import x from "./x.js";\nimport y from \'./y.js\';\n'),
        ['./x.js', './y.js']);
});

test('imports are reported in source order', () => {
    assert.deepEqual(parseImports("import a from './a.js';\nimport b from './b.js';\n"),
        ['./a.js', './b.js']);
});

// The failure mode that matters: a match that wanders out of the import section
// invents a dependency, and the checker then reports a file "missing" that was
// never needed.
test('a string literal in ordinary code is not mistaken for an import', () => {
    const source = [
        "import {Confidence} from './confidence.js';",
        '',
        'export function assess(reading) {',
        "    if (!reading) return {level: Confidence.UNKNOWN, summary: 'No data'};",
        "    return {level: Confidence.LOW, summary: 'Nominal', detail: `${reading.mhz} MHz`};",
        '}',
    ].join('\n');
    assert.deepEqual(parseImports(source), ['./confidence.js']);
});

test('an exported constant holding a string is not mistaken for a re-export', () => {
    assert.deepEqual(parseImports("export const NAME = 'thermal-throttle-monitor';\n"), []);
});

test('a property called "from" does not create a phantom import', () => {
    assert.deepEqual(parseImports("export const pick = list => list.from ? 'a' : 'b';\n"), []);
});

test('a file with no imports yields none', () => {
    assert.deepEqual(parseImports('export const x = 1;\n'), []);
    assert.deepEqual(parseImports(''), []);
});

// The previous parser was hand-written and was defeated twice. These are the
// shapes that defeat a scanner but not a parser; they are here so that swapping
// the implementation back for something cheaper has to answer for them.
test('constructs that defeat a text scanner are handled', () => {
    const cases = {
        'nested template literal': 'export const X = `a ${`inner ${1}`} b`;\nimport r from "./real.js";',
        'backtick inside ${}': 'export const X = `${[`import x from "./ghost.js"`]}`;\nimport r from "./real.js";',
        'division that is not a regexp': 'export const q = (a) / (b) / (c);\nimport r from "./real.js";',
        'regexp containing slashes': String.raw`export const re = /a\/\/b/;` + '\nimport r from "./real.js";',
        'regexp containing a backtick': 'export const re = /`/;\nimport r from "./real.js";',
        'string ending in an escaped backslash': 'export const s = "\\\\";\nimport r from "./real.js";',
        'CRLF line endings': 'import {\r\n  a,\r\n} from "./real.js";\r\n',
        'a method called import': 'class C { import() { return 1; } }\nimport r from "./real.js";',
        'a byte order mark': '\uFEFFimport r from "./real.js";',
    };
    for (const [name, source] of Object.entries(cases))
        assert.deepEqual(parseImports(source), ['./real.js'], name);
});

test('a dynamic import is not a static dependency', () => {
    // It is resolved at runtime, so it says nothing about what must be packaged
    // — and this extension has none.
    assert.deepEqual(parseImports('const p = import("./lazy.js");\n'), []);
});

test('import.meta is not an import', () => {
    assert.deepEqual(parseImports('export const u = import.meta.url;\n'), []);
});

test('an export with no source names no module', () => {
    assert.deepEqual(parseImports('const a = 1;\nexport {a};\n'), []);
    assert.deepEqual(parseImports('export default 1;\n'), []);
});

test('a file that does not parse is reported, not silently treated as importless', () => {
    // Returning [] here would let a corrupt module look like a leaf with no
    // dependencies, which is exactly the silent direction this guard exists to
    // avoid. The caller turns this into a package problem.
    assert.throws(() => parseImports('const x = ;\n'), SyntaxError);
});

test('runtime specifiers are the ones GNOME Shell provides', () => {
    assert.equal(isRuntimeSpecifier('gi://Gio'), true);
    assert.equal(isRuntimeSpecifier('resource:///org/gnome/shell/ui/main.js'), true);
    assert.equal(isRuntimeSpecifier('./confidence.js'), false);
    assert.equal(isRuntimeSpecifier('../sysfs/port.js'), false);
    assert.equal(isRuntimeSpecifier('node:fs'), false);
});

// ── The check itself ───────────────────────────────────────────────────────
//
// Everything above tests the parser. The function that uses it had never been
// run against anything but a sound package, so none of its refusals had ever
// fired — a guard nobody has watched fail is a guard nobody knows works, which
// is how this repository has been wrong before.

/** Build a package directory from a `relative path → contents` map. */
function packageOf(files) {
    const root = mkdtempSync(join(tmpdir(), 'ttm-pkg-'));
    for (const [relative, contents] of Object.entries(files)) {
        const path = join(root, relative);
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, contents);
    }
    return root;
}

/** The smallest package that must pass: two entry points and their one module. */
const SOUND = {
    'metadata.json': '{"uuid":"x"}',
    'stylesheet.css': '.x {}',
    'LICENSE': 'GPL-2.0-or-later\n',
    'schemas/org.gnome.shell.extensions.x.gschema.xml': '<schemalist/>\n',
    'extension.js': "import {a} from './src/rule.js';\nimport St from 'gi://St';\nexport default a;\n",
    'prefs.js': "import Adw from 'gi://Adw';\nexport default Adw;\n",
    'src/rule.js': 'export const a = 1;\n',
};

const problemsFor = async files => {
    const root = packageOf(files);
    try {
        return (await checkPackage(root)).problems;
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
};

test('a sound package has no problems', async () => {
    const root = packageOf(SOUND);
    try {
        const {problems, moduleCount} = await checkPackage(root);
        assert.deepEqual(problems, []);
        assert.equal(moduleCount, 3, 'both entry points and the module they share');
    } finally {
        rmSync(root, {recursive: true, force: true});
    }
});

test('a module an entry point imports but the package omits is reported', async () => {
    const {['src/rule.js']: _dropped, ...missing} = SOUND;
    const problems = await problemsFor(missing);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /src\/rule\.js.*not in the package/);
});

test('a module nothing imports is reported', async () => {
    const problems = await problemsFor({...SOUND, 'src/stray.js': 'export const b = 2;\n'});
    assert.deepEqual(problems, ['src/stray.js is in the package but nothing imports it']);
});

test('a module that does not parse is reported once, and as such', async () => {
    // Two different repairs: "not in the package" sends whoever reads it looking
    // for a packaging bug that is really a syntax error. And the file is present,
    // so the unreferenced sweep must not also call it an orphan — one fault, one
    // problem, or the second one is simply untrue.
    const problems = await problemsFor({...SOUND, 'src/rule.js': 'export const a = ;\n'});
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /src\/rule\.js does not parse as an ES module/);
});

test('a runtime import outside an adapter is reported', async () => {
    // The layering must hold in the artifact and not only in the repository:
    // lint runs against the working tree, and the zip is what users receive.
    const problems = await problemsFor({
        ...SOUND,
        'src/rule.js': "import Gio from 'gi://Gio';\nexport const a = Gio;\n",
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /src\/rule\.js imports gi:\/\/Gio, which only an adapter may do/);
});

test('the entry points and the Gio adapter may import a runtime', async () => {
    const {['src/rule.js']: _replaced, ...rest} = SOUND;
    const problems = await problemsFor({
        ...rest,
        'extension.js':
            "import St from 'gi://St';\nimport {g} from './src/sysfs/gio.js';\nexport default g;\n",
        'src/sysfs/gio.js': "import Gio from 'gi://Gio';\nexport const g = Gio;\n",
    });
    assert.deepEqual(problems, []);
});

test('a package missing a file the extension cannot start without is reported', async () => {
    for (const required of ['metadata.json', 'stylesheet.css', 'LICENSE']) {
        const {[required]: _dropped, ...without} = SOUND;
        assert.deepEqual(await problemsFor(without),
            [`${required} is missing from the package`]);
    }
});

test('several problems are all reported, not just the first', async () => {
    const {['metadata.json']: _m, ...broken} = SOUND;
    const problems = await problemsFor({...broken, 'src/stray.js': 'export const b = 2;\n'});
    assert.equal(problems.length, 2, problems.join('; '));
});

// The schema, from both sides. `make pack` names the archive's contents by hand
// and then excludes the compiled form, so either half can be got wrong by
// editing one line — and neither failure shows up until a user installs it.
test('a package with no schema source cannot have its settings compiled', async () => {
    const {['schemas/org.gnome.shell.extensions.x.gschema.xml']: _dropped, ...without} = SOUND;
    assert.deepEqual(await problemsFor(without),
        ['no .gschema.xml in the package; GNOME cannot compile the settings']);
});

test('a compiled schema is a build artifact and is refused', async () => {
    assert.deepEqual(
        await problemsFor({...SOUND, 'schemas/gschemas.compiled': 'binary'}),
        ['schemas/gschemas.compiled is a build artifact and should not be packaged']);
});

// The entry points are `.js` today and nothing enforces that, so the orphan
// sweep looks for both module extensions rather than the one in use.
test('a stray .mjs is an orphan too, not something the sweep cannot see', async () => {
    assert.deepEqual(
        await problemsFor({...SOUND, 'src/scratch.mjs': 'export const x = 1;\n'}),
        ['src/scratch.mjs is in the package but nothing imports it']);
});
