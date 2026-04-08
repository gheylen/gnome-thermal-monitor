UUID = thermal-throttle-monitor@glennheylen.com

.PHONY: all pack schema lint clean

all: pack

# Build distributable zip (output: dist/<UUID>.shell-extension.zip)
pack: schema
	mkdir -p dist
	gnome-extensions pack \
		--extra-source=backends/ \
		--extra-source=lib/ \
		--force \
		-o dist/ \
		.

# Compile GSettings schema (required before enabling the extension)
schema:
	glib-compile-schemas schemas/

# Run ESLint
lint:
	npm run lint

# Remove build artifacts
clean:
	rm -rf dist/ schemas/gschemas.compiled
