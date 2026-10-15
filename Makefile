NODE_BIN := node_modules/.bin

# ARCH=x64 or ARCH=arm64 builds a single arch; empty builds every arch in electron-builder.yml
ARCH ?=
ARCH_FLAG := $(if $(ARCH),--$(ARCH))

# Same range as engines.node in package.json
NODE_CHECK = const [a,b,c]=process.versions.node.split(".").map(Number); \
  const ok=(a===22&&(b>22||(b===22&&c>=2)))||(a===24&&b>=15)||a>=26; \
  if(!ok){console.error("Error: Node.js ^22.22.2, ^24.15.0 or >=26 required (found v"+process.versions.node+"). Run: nvm install && nvm use");process.exit(1)}

# Dev profile (#0038): `make dev` runs against ~/.corner-office/profiles/$(PROFILE); PROFILE= (empty) uses your real data.
# PROFILE_RE must stay equal to PROFILE_NAME_RE in src/main/services/app-home.ts (profile-name-regex.test.ts pins it).
PROFILE ?= dev
DEBUG_PORT ?=
PROFILE_RE := ^[a-z0-9][a-z0-9-]{0,31}$$
export PROFILE DEBUG_PORT

.PHONY: setup check-node rebuild-native dev dev-guard dev-sandbox dev-sandbox-stop build package-deb package-rpm package-appimage dist clean install test test-watch lint help
.DEFAULT_GOAL := help

# ──────────────────────────────────────────────────────────────────────────────
# check-node: verify the Node.js version against engines.node
# ──────────────────────────────────────────────────────────────────────────────
check-node:
	@node -e '$(NODE_CHECK)'

# ──────────────────────────────────────────────────────────────────────────────
# setup: verify Node.js version, install dependencies, download Electron, build native modules
# ──────────────────────────────────────────────────────────────────────────────
setup: check-node
	pnpm install --frozen-lockfile
	@# Electron >=42 has no postinstall; download it once, in the foreground
	pnpm exec install-electron
	$(MAKE) rebuild-native
	@echo ""
	@echo "Corner Office is ready. Run 'make dev' to start."

# ──────────────────────────────────────────────────────────────────────────────
# rebuild-native: build node-pty against the installed Electron's headers
# ──────────────────────────────────────────────────────────────────────────────
rebuild-native:
	@for t in python3 make g++; do command -v $$t >/dev/null 2>&1 || { \
	  echo "Error: $$t not found. node-pty is built from source on Linux; install python3, make and g++ (e.g. sudo apt-get install build-essential python3)."; exit 1; }; done
	$(NODE_BIN)/electron-builder install-app-deps || { \
	  echo "Error: building native modules failed. This step downloads the Electron headers; if the log above shows a timeout or network error, check your connection to electronjs.org and run 'make rebuild-native' again."; exit 1; }

# ──────────────────────────────────────────────────────────────────────────────
# dev: start Electron in development mode with hot reload
# ──────────────────────────────────────────────────────────────────────────────
dev: dev-guard check-node rebuild-native
	@echo "==> profile: $(if $(filter-out default,$(PROFILE)),$(PROFILE) (~/.corner-office/profiles/$(PROFILE))  [PROFILE= for your real data],default (REAL DATA, ~/.corner-office))"
	CORNER_OFFICE_PROFILE=$(PROFILE) CORNER_OFFICE_DEBUG_PORT=$(DEBUG_PORT) $(NODE_BIN)/electron-vite dev

# dev-sandbox: the headless dev app inside a sandbox session (CDP on :9222). Inside a sandbox session only.
dev-sandbox:
	@scripts/co_dev_sandbox.sh --wait

dev-sandbox-stop:
	@scripts/co_dev_sandbox.sh --stop

# dev-guard: refuse inside a sandbox, then validate PROFILE and DEBUG_PORT before anything slow runs.
# PROFILE and DEBUG_PORT are exported, so the shell reads them from the environment (never pasted into the script).
dev-guard:
	@if [ "$$CORNER_OFFICE_SANDBOX" = "1" ]; then echo "Inside a sandbox session use: make dev-sandbox"; exit 2; fi
	@if [ -n "$$PROFILE" ] && { ! printf '%s' "$$PROFILE" | grep -Eq '$(PROFILE_RE)' || [ "$$(printf '%s' "$$PROFILE" | wc -l)" -ne 0 ]; }; then \
	  printf '%s\n' "PROFILE=\"$$PROFILE\" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit. Example: make dev PROFILE=dev" >&2; exit 2; fi
	@if [ -n "$$DEBUG_PORT" ] && { ! printf '%s' "$$DEBUG_PORT" | grep -Eq '^[0-9]{1,5}$$' || [ "$$(printf '%s' "$$DEBUG_PORT" | wc -l)" -ne 0 ] || [ "$$DEBUG_PORT" -lt 1024 ] || [ "$$DEBUG_PORT" -gt 65535 ]; }; then \
	  printf '%s\n' "DEBUG_PORT=\"$$DEBUG_PORT\" is invalid. Use a port from 1024 to 65535, or leave it empty. Example: make dev DEBUG_PORT=9223" >&2; exit 2; fi

# ──────────────────────────────────────────────────────────────────────────────
# build: compile all three processes for production
# ──────────────────────────────────────────────────────────────────────────────
build:
	$(NODE_BIN)/electron-vite build

# ──────────────────────────────────────────────────────────────────────────────
# packaging targets (all depend on build)
# ──────────────────────────────────────────────────────────────────────────────
package-deb: build
	$(NODE_BIN)/electron-builder --linux deb $(ARCH_FLAG)

package-rpm: build
	@command -v rpmbuild >/dev/null 2>&1 || { echo "Error: rpmbuild not found. Install with: sudo apt-get install rpm"; exit 1; }
	$(NODE_BIN)/electron-builder --linux rpm $(ARCH_FLAG)

package-appimage: build
	$(NODE_BIN)/electron-builder --linux AppImage $(ARCH_FLAG)

# dist: build available Linux package formats (skips rpm if rpmbuild not installed)
dist: build
	@TARGETS="deb AppImage"; \
	if command -v rpmbuild >/dev/null 2>&1; then TARGETS="deb rpm AppImage"; fi; \
	$(NODE_BIN)/electron-builder --linux $$TARGETS $(ARCH_FLAG)

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
	@echo "  make setup            Verify Node.js, install deps, download Electron, build native modules"
	@echo "  make rebuild-native   Rebuild node-pty for the installed Electron"
	@echo "  make dev              Start Electron in dev mode with hot reload, as profile 'dev'"
	@echo "                        (PROFILE=name for another profile, PROFILE= for your real data, DEBUG_PORT=n for CDP)"
	@echo "  make dev-sandbox      (inside a sandbox session only) start the headless dev app; CDP on :9222"
	@echo "  make dev-sandbox-stop Stop the headless dev app"
	@echo "  make build            Compile all processes for production"
	@echo "  make dist             Build deb + AppImage (+ rpm if rpmbuild available)"
	@echo "  make package-deb      Build .deb package"
	@echo "  make package-rpm      Build .rpm package (requires rpmbuild)"
	@echo "  make package-appimage Build .AppImage package"
	@echo "  make test             Run unit tests"
	@echo "  make test-watch       Run tests in watch mode"
	@echo "  make lint             Run ESLint + TypeScript type check"
	@echo "  make clean            Remove build artifacts"
	@echo ""
	@echo "  Packaging targets accept ARCH=x64 or ARCH=arm64 (default: all arches)"
