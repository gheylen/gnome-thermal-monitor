// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Verify a built extension directory is complete, correctly layered, and
// carrying nothing it should not.
//
// `make pack` names the files that go into the zip by hand, so a new top-level
// module can be imported by extension.js and left out of the archive. Nothing
// else would notice: lint and the tests run against the working tree, not the
// artifact, and the first symptom would be an extension that fails to enable on
// a user's machine.
//
// Usage: node tools/check-package.mjs <directory>
// Tested by test/tools/check-package.test.js.

import {readFileSync} from 'node:fs';
import {glob} from 'node:fs/promises';
import {dirname, join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {parse} from 'espree';

/** GNOME Shell provides these; they are not files we ship. */
export const isRuntimeSpecifier = specifier =>
    specifier.startsWith('gi://') || specifier.startsWith('resource://');

/**
 * Static import and re-export specifiers, in source order.
 *
 * Parsed, not pattern-matched. The previous version scanned the raw text and
 * was defeated twice — once by a comment holding an apostrophe inside an import
 * list, which hid the statement entirely, and once by an import-looking line
 * inside a template literal, which invented a dependency. Both directions of
 * that mistake are expensive: one ships a package missing a module, the other
 * fails a sound build. Espree is ESLint's parser and is already in the tree, so
 * this costs a build-time dependency and nothing else.
 *
 * @param {string} source
 * @returns {string[]}
 * @throws {SyntaxError} If the source does not parse as an ES module.
 */
export function parseImports(source) {
    const program = parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReserved: false,
    });

    return program.body
        .filter(node => IMPORTING_NODES.has(node.type) && node.source !== null)
        .map(node => node.source.value);
}

/** The node types that name another module. `import()` is dynamic and not one. */
const IMPORTING_NODES = new Set([
    'ImportDeclaration',
    'ExportNamedDeclaration',   // only when it has a `from`, hence the null check
    'ExportAllDeclaration',
]);

/**
 * @param {string} root  Directory holding the built extension.
 * @returns {Promise<{problems: string[], moduleCount: number}>}
 *   `problems` is empty when the package is sound.
 */
export async function checkPackage(root) {
    const problems = [];
    const ENTRY_POINTS = ['extension.js', 'prefs.js'];
    const RUNTIME_ALLOWED = new Set([...ENTRY_POINTS, join('src', 'sysfs', 'gio.js')]);

    // Each module is parsed once and its specifiers kept: the layering pass below
    // needs them too, and a file that failed to parse must not be parsed again
    // and reported twice.
    const importsByFile = new Map();
    const reached = new Set();

    // Every module reachable from the entry points must be present.
    const walk = (file, importedBy) => {
        if (reached.has(file)) return;

        let source;
        try {
            source = readFileSync(file, 'utf8');
        } catch {
            problems.push(
                `${relative(root, file)} is imported by ${importedBy} but is not in the package`);
            return;
        }

        // Present, whatever else is wrong with it. Marking it reached is what
        // stops the unreferenced sweep below from also calling it an orphan —
        // two problems for one fault, the second of them untrue.
        reached.add(file);

        let specifiers;
        try {
            specifiers = parseImports(source);
        } catch (error) {
            problems.push(
                `${relative(root, file)} does not parse as an ES module: ${error.message}`);
            return;
        }

        importsByFile.set(file, specifiers);
        for (const specifier of specifiers) {
            if (isRuntimeSpecifier(specifier)) continue;
            walk(resolve(dirname(file), specifier), relative(root, file));
        }
    };
    for (const entryPoint of ENTRY_POINTS) walk(join(root, entryPoint), 'the package manifest');

    // Nothing that only the test suite needs should have come along. Both
    // module extensions, so a `.mjs` dropped in is an orphan rather than
    // invisible — the entry points are `.js` today and nothing enforces that.
    for await (const found of glob('**/*.{js,mjs}', {cwd: root})) {
        if (!reached.has(join(root, found)))
            problems.push(`${found} is in the package but nothing imports it`);
    }

    // The layering must hold in the artifact, not just in the repository.
    for (const [file, specifiers] of importsByFile) {
        const name = relative(root, file);
        if (RUNTIME_ALLOWED.has(name)) continue;
        const runtime = specifiers.filter(isRuntimeSpecifier);
        if (runtime.length > 0)
            problems.push(`${name} imports ${runtime.join(', ')}, which only an adapter may do`);
    }

    // Files the extension cannot start without, or must not be shipped without:
    // GNOME Shell reads the first two, and LICENSE is what makes redistributing
    // a GPL extension lawful. `make pack` names the archive's contents by hand,
    // so any of them can be dropped by editing one line in the Makefile.
    for (const required of ['metadata.json', 'stylesheet.css', 'LICENSE']) {
        try {
            readFileSync(join(root, required));
        } catch {
            problems.push(`${required} is missing from the package`);
        }
    }

    // The schema, from both sides. The `.gschema.xml` source is what GNOME needs
    // in order to compile the settings; `gschemas.compiled` is a build artifact,
    // and extensions.gnome.org's review guidelines ask submissions not to carry
    // files they do not need in order to function.
    const schemas = [];
    for await (const found of glob('schemas/*', {cwd: root})) schemas.push(found);
    if (!schemas.some(name => name.endsWith('.gschema.xml')))
        problems.push('no .gschema.xml in the package; GNOME cannot compile the settings');
    for (const compiled of schemas.filter(name => name.endsWith('gschemas.compiled')))
        problems.push(`${compiled} is a build artifact and should not be packaged`);

    return {problems, moduleCount: reached.size};
}

// Run only when invoked directly, so the test suite can import the pieces above.
// `argv[1]` is undefined under `node -e`, where nothing should run at all.
const invokedDirectly = process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
    const {problems, moduleCount} = await checkPackage(resolve(process.argv[2] ?? '.'));
    if (problems.length > 0) {
        for (const problem of problems) console.error(`  ${problem}`);
        console.error(`package check failed: ${problems.length} problem(s)`);
        process.exit(1);
    }
    console.log(`package check: ${moduleCount} modules, all resolved and correctly layered`);
}
