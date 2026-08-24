// SPDX-FileCopyrightText: 2026 G Heylen
// SPDX-License-Identifier: GPL-2.0-or-later

// Discovery — turn the driver registry into the component list a Monitor drives.
//
// Runs once, at enable().  Its job is to be unshakeable: a driver that throws,
// returns junk, or collides with another driver's component id must cost that
// driver its components and nothing more.  The extension has to come up on
// hardware nobody tested it against.

/**
 * @typedef {object} Driver
 * @property {string} name      Human-readable, used in diagnostics.
 * @property {string} category  Hardware class: 'cpu' | 'gpu' | 'npu' | …
 * @property {(sysfs: import('../sysfs/port.js').Sysfs) => import('./monitor.js').Component[]} discover
 *   Returns [] when the hardware is absent.  Must not throw (enforced here anyway).
 *
 * @typedef {object} Discovery
 * @property {import('./monitor.js').Component[]} components
 * @property {string[]} missingCategories  Categories no driver found hardware for.
 */

/**
 * Turn whatever a driver returned into a component this module vouches for.
 *
 * A copy rather than the original, for two reasons.  `id` is read exactly once
 * and fixed here, because the Monitor keys its previous-reading map and the
 * popup sections by it — a property that answered differently on a later read
 * would silently split one component in two.  And the result is frozen, so
 * nothing downstream can be reshaped after discovery vouched for it.
 *
 * The methods are wrapped rather than copied across.  A driver is free to
 * return a class instance, and `read` and `assess` would then live on its
 * prototype, where a spread does not reach them: the component would pass every
 * check here and throw on the first poll.  Calling through preserves both the
 * methods and their `this`.
 *
 * @param {unknown} value
 * @returns {import('./monitor.js').Component}
 * @throws {TypeError} If it is not usable as a component.
 */
function normalize(value) {
    if (value === null || typeof value !== 'object')
        throw new TypeError(`expected an object, got ${value === null ? 'null' : typeof value}`);

    const id = value.id;
    if (typeof id !== 'string' || id === '')
        throw new TypeError('id must be a non-empty string');
    if (typeof value.title !== 'string')
        throw new TypeError('title must be a string');
    if (typeof value.read !== 'function' || typeof value.assess !== 'function')
        throw new TypeError('read and assess must be functions');

    // Optional projections are copied by name, so adding one to the Component
    // contract means adding it here too. That is deliberate — discovery vouches
    // for a fixed shape rather than passing through whatever a driver returned —
    // but it is also exactly how a projection can be added to an adapter, wired
    // into the Monitor, and silently never arrive. It happened once.
    const projection = name => typeof value[name] === 'function'
        ? {[name]: reading => value[name](reading)}
        : {};

    return Object.freeze({
        id,
        title: value.title,
        read: () => value.read(),
        assess: (reading, previous, context) => value.assess(reading, previous, context),
        ...projection('temperatureC'),
        ...projection('throttlePointC'),
    });
}

/**
 * @param {Driver[]} drivers
 * @param {import('../sysfs/port.js').Sysfs} sysfs
 * @param {(message: string) => void} [onWarning]
 * @returns {Discovery}
 */
export function discoverComponents(drivers, sysfs, onWarning) {
    const components = [];
    const claimedIds = new Set();
    const foundCategories = new Set();

    for (const driver of drivers) {
        let discovered;
        try {
            discovered = driver.discover(sysfs);
        } catch (error) {
            onWarning?.(`${driver.name} backend failed during discovery: ${error}`);
            continue;
        }
        if (discovered === undefined || discovered === null) continue;
        if (!Array.isArray(discovered)) {
            onWarning?.(`${driver.name} backend returned ${typeof discovered}, not a component list`);
            continue;
        }

        let kept = 0;
        for (const component of discovered) {
            // Reading a property can run a getter, and a getter can throw.  Doing
            // that outside a `try` would cost every other driver its components
            // too — the opposite of what this guard exists for.
            //
            // `id` is read once and that value is what everything downstream
            // sees, because the Monitor keys its previous-reading map and the
            // popup sections by it: a getter answering differently on a later
            // read would silently split one component in two.
            let claimed;
            try {
                claimed = normalize(component);
            } catch (error) {
                onWarning?.(
                    `${driver.name} backend returned something that is not a component: ${error}`);
                continue;
            }

            if (claimedIds.has(claimed.id)) {
                // Two drivers claiming one id would silently share a popup section
                // and a previous-reading slot.  Keep the first; report the clash.
                onWarning?.(
                    `${driver.name} backend re-used component id "${claimed.id}" — ignored`);
                continue;
            }
            claimedIds.add(claimed.id);
            components.push(claimed);
            kept++;
        }
        if (kept > 0) foundCategories.add(driver.category);
    }

    const allCategories = new Set(drivers.map(driver => driver.category));
    const missingCategories = [...allCategories].filter(category => !foundCategories.has(category));

    return {components, missingCategories};
}
