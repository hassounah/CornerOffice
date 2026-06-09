NODE_BIN := node_modules/.bin
REQUIRED_NODE_MAJOR := 20

.PHONY: setup dev build package-deb package-rpm package-appimage dist clean install test test-watch lint help
.DEFAULT_GOAL := help

# ──────────────────────────────────────────────────────────────────────────────
# setup: verify Node.js version, install dependencies, print ready message
# ──────────────────────────────────────────────────────────────────────────────
setup:
	@NODE_MAJOR=$$(node -e "process.stdout.write(process.versions.node.split('.')[0])"); \
	if [ "$$NODE_MAJOR" -lt "$(REQUIRED_NODE_MAJOR)" ]; then \
		echo "Error: Node.js v$(REQUIRED_NODE_MAJOR)+ required (found v$$NODE_MAJOR)"; \
		exit 1; \
	fi
	pnpm install --frozen-lockfile
	@echo ""
	@echo "Corner Office is ready. Run 'make dev' to start."

# ──────────────────────────────────────────────────────────────────────────────
# dev: start Electron in development mode with hot reload
# ──────────────────────────────────────────────────────────────────────────────
dev:
	$(NODE_BIN)/electron-vite dev

# ──────────────────────────────────────────────────────────────────────────────
# build: compile all three processes for production
# ──────────────────────────────────────────────────────────────────────────────
build:
	$(NODE_BIN)/electron-vite build

# ──────────────────────────────────────────────────────────────────────────────
# packaging targets (all depend on build)
# ──────────────────────────────────────────────────────────────────────────────
package-deb: build
	$(NODE_BIN)/electron-builder --linux deb

package-rpm: build
	@command -v rpmbuild >/dev/null 2>&1 || { echo "Error: rpmbuild not found. Install with: sudo apt-get install rpm"; exit 1; }
	$(NODE_BIN)/electron-builder --linux rpm

package-appimage: build
	$(NODE_BIN)/electron-builder --linux AppImage

# dist: build available Linux package formats (skips rpm if rpmbuild not installed)
dist: build
	@TARGETS="deb AppImage"; \
	if command -v rpmbuild >/dev/null 2>&1; then TARGETS="deb rpm AppImage"; fi; \
	$(NODE_BIN)/electron-builder --linux $$TARGETS

# ──────────────────────────────────────────────────────────────────────────────
# clean: remove build artifacts
# ──────────────────────────────────────────────────────────────────────────────
clean:
	rm -rf dist out release

# ──────────────────────────────────────────────────────────────────────────────
# install: alias for setup
# ──────────────────────────────────────────────────────────────────────────────
install: setup

# ──────────────────────────────────────────────────────────────────────────────
# test: run unit tests once
# ──────────────────────────────────────────────────────────────────────────────
test:
	$(NODE_BIN)/vitest run

# ──────────────────────────────────────────────────────────────────────────────
# test-watch: run tests in watch mode
# ──────────────────────────────────────────────────────────────────────────────
test-watch:
	$(NODE_BIN)/vitest

# ──────────────────────────────────────────────────────────────────────────────
# lint: run ESLint + TypeScript type check
# ──────────────────────────────────────────────────────────────────────────────
lint:
	$(NODE_BIN)/eslint src && $(NODE_BIN)/tsc --noEmit

# ──────────────────────────────────────────────────────────────────────────────
# help: show available targets
# ──────────────────────────────────────────────────────────────────────────────
help:
	@echo "Corner Office"
	@echo ""
	@echo "  make setup            Install dependencies and verify Node.js"
	@echo "  make dev              Start Electron in dev mode with hot reload"
	@echo "  make build            Compile all processes for production"
	@echo "  make dist             Build deb + AppImage (+ rpm if rpmbuild available)"
	@echo "  make package-deb      Build .deb package"
	@echo "  make package-rpm      Build .rpm package (requires rpmbuild)"
	@echo "  make package-appimage Build .AppImage package"
	@echo "  make test             Run unit tests"
	@echo "  make test-watch       Run tests in watch mode"
	@echo "  make lint             Run ESLint + TypeScript type check"
	@echo "  make clean            Remove build artifacts"
