UUID = thermal-throttle-monitor@glennheylen.com

.PHONY: all pack schema lint clean install

all: pack

# Build distributable zip (output: dist/<UUID>.shell-extension.zip)
pack: schema
	mkdir -p dist
	zip -r dist/$(UUID).shell-extension.zip \
		backends/ \
		lib/ \
		schemas/ \
		extension.js \
		prefs.js \
		stylesheet.css \
		metadata.json

# Compile GSettings schema (required before enabling the extension)
schema:
	glib-compile-schemas schemas/

# Run ESLint
lint:
	npm run lint

# Symlink the source tree into the user extensions directory (dev workflow).
# Compiles the schema in-place so the extension can be enabled immediately.
install: schema
	mkdir -p $(HOME)/.local/share/gnome-shell/extensions/
	ln -snf $(CURDIR) $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

# Remove build artifacts
clean:
	rm -rf dist/ schemas/gschemas.compiled
