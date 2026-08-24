UUID    := thermal-throttle-monitor@gheylen.github.io
ZIP     := dist/$(UUID).shell-extension.zip
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

# Everything the extension needs at runtime.  `make pack` verifies the result
# with tools/check-package.mjs, which fails if a module the entry points import
# is missing, if anything unreferenced crept in, or if the layering is broken.
SOURCES := src/ schemas/ extension.js prefs.js stylesheet.css metadata.json LICENSE

.DEFAULT_GOAL := check
.PHONY: all help check lint test test-gjs test-prefs schema pack pins mutate verify-pins \
	install uninstall clean

all: pack

## help     List these targets.
#
# Every target documents itself with a `## name  description` line above it;
# this prints them, so the list cannot drift from the Makefile it describes.
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  /'

## check    Run everything CI runs.  `pack` covers `schema`.
check: lint test test-gjs pins pack

## pins     Check every GitHub Action is SHA-pinned and labelled (offline).
#
# The other half — resolving each pin upstream — is `verify-pins`, which needs
# network.  This half needs none, so it belongs in the gate: an action added by
# hand without a pin fails here rather than waiting to be noticed.
pins:
	sh tools/verify-pins.sh --offline

## lint     ESLint, including the architecture import rules.
lint:
	npm run lint

## test     Unit and integration tests (plain Node, no GJS runtime needed).
test:
	npm test

## test-gjs Run the tests that need a real GJS runtime (test/gjs/*.gjs.js).
test-gjs:
	npm run test:gjs

## test-prefs Drive prefs.js against real libadwaita widgets (needs GNOME + a display).
#
# Not part of `check`, which must work offline and on a machine with no desktop.
# This imports the real `prefs.js`, which means resolving its
# `resource:///org/gnome/Shell/Extensions/…` import — possible outside the
# Extensions application because that application's JavaScript ships as a
# GResource that any GJS process can register.  Needs gnome-shell's data files,
# libadwaita's typelib, and a display; on a GNOME desktop all three are already
# there.  Elsewhere: `xvfb-run -a make test-prefs`.
test-prefs:
	GI_TYPELIB_PATH="$${GI_TYPELIB_PATH}:/usr/lib/gnome-shell/girepository-1.0" \
		gjs -m test/prefs/keep-ordered.gjs.js

## schema   Compile and validate the GSettings schema.
schema:
	glib-compile-schemas --strict schemas/

## pack     Build the distributable zip at dist/<UUID>.shell-extension.zip.
#
# The schema is compiled first to validate it, but gschemas.compiled is a build
# artifact: extensions.gnome.org recompiles schemas itself, and its review
# guidelines ask submissions not to carry files they do not need to function.
# The .gschema.xml source is required and is included.
pack: schema
	@rm -rf dist
	@mkdir -p dist
	zip -q -r $(ZIP) $(SOURCES) -x 'schemas/gschemas.compiled'
	@# Check the artifact itself, not the working tree: SOURCES is maintained by
	@# hand, so a new top-level module can be imported and never packaged — and
	@# the same one line decides whether the schema source, the licence or the
	@# stylesheet travel with it.  check-package.mjs answers all of that, and is
	@# tested; a `grep` over `unzip -l` here would not be.
	@rm -rf dist/verify && mkdir -p dist/verify && unzip -q $(ZIP) -d dist/verify
	@node tools/check-package.mjs dist/verify
	@rm -rf dist/verify
	@echo "built $(ZIP)"

## mutate   Break the code on purpose and require the tests to notice.
#
# Not part of `check`: it runs the whole suite once per mutant, which is minutes
# rather than seconds even spread across every core.  A surviving mutant is a gap
# in the tests, and a stale one is a check that quietly stopped checking; both
# fail the run.  `--filter <substring>` narrows it while working on one rule.
mutate:
	node tools/mutate.mjs

## verify-pins  Check every SHA-pinned GitHub Action resolves upstream (needs network).
#
# Not part of `check`: it needs the network, and `check` must work offline.
verify-pins:
	sh tools/verify-pins.sh

## install  Symlink this tree into the user extensions directory (dev workflow).
install: schema
	@if [ -e "$(EXT_DIR)" ] && [ ! -L "$(EXT_DIR)" ]; then \
		echo "$(EXT_DIR) exists and is not a symlink; remove it first"; exit 1; fi
	@mkdir -p "$(dir $(EXT_DIR))"
	ln -snf "$(CURDIR)" "$(EXT_DIR)"
	@echo "linked; log out and back in, then: gnome-extensions enable $(UUID)"

## uninstall Remove the development symlink.
uninstall:
	@if [ -L "$(EXT_DIR)" ]; then rm "$(EXT_DIR)"; echo "removed $(EXT_DIR)"; \
		else echo "nothing to remove"; fi

## clean    Remove build artifacts.
clean:
	rm -rf dist/ schemas/gschemas.compiled
