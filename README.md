# Corner Office

A desktop dashboard for the [Corner Office](https://github.com/hassounah/amerh) Claude Code plugin. Gives you a CEO-view over your workspaces, pipelines, sessions, and team activity — all from a single app.

Built for solo devs, indie hackers, and small team founders who run Claude Code as their engineering team.

## What It Does

- **Workspace discovery** — automatically finds all projects with `.rix/` directories and watches for changes in real time
- **Pipeline tracking** — see active, parked, and completed feature pipelines with gate progress (design, plan, implementation)
- **Session awareness** — live connection to Claude Code sessions via WebSocket channels, with permission request relay (approve/deny tool calls from the app)
- **In-app chat** — talk to Claude sessions directly from the workspace view
- **Terminal emulator** — embedded shell terminals powered by xterm.js and node-pty
- **Document viewer** — browse TRDs, plans, review reports, and other pipeline artifacts with full markdown rendering
- **Notifications** — OS-level and in-app notification system with tier-based filtering and quiet hours
- **Gamification** — XP, levels, streaks, and achievements based on shipping features
- **Sandbox sessions** — run Claude Code unattended in a local Docker container, on its own git worktree, behind a DNS allowlist (see [Sandbox Sessions](#sandbox-sessions))
- **Two UI skins** — Office (clean dashboard) and Realm (medieval fantasy theme with a kingdom map, wizard's study, and character sprites)

## Screenshots

*Coming soon*

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 44 |
| Frontend | React 19, React Router 8, Zustand 5 |
| Styling | Tailwind CSS 4, Outfit font |
| Terminal | xterm.js 6, node-pty 1.1 |
| Markdown | react-markdown 10, remark-gfm |
| Charts | Recharts 3 |
| Build | electron-vite 5, Vite 7 |
| Testing | Vitest 5, Testing Library, Playwright |
| Linting | ESLint 10 (flat config), TypeScript 6.0 |
| IPC validation | Zod 4 |

## Install

Download the package for your distro and CPU from the [latest release](https://github.com/hassounah/CornerOffice/releases/latest), then:

```bash
# Debian/Ubuntu (arm64.deb on ARM)
sudo apt install ./CornerOffice-<version>-amd64.deb

# Fedora/RHEL (aarch64.rpm on ARM)
sudo dnf install ./CornerOffice-<version>-x86_64.rpm
```

Each release also includes a `SHA256SUMS` file (`sha256sum -c SHA256SUMS --ignore-missing`).

## Requirements

- Node.js ^22.22.2 or ≥24.15 (24 recommended; `nvm install && nvm use`)
- pnpm 10.34.6, pinned via `packageManager`: run `corepack enable` once; don't use another pnpm major
- python3, make and g++ (node-pty is built from source on Linux)

## Getting Started

```bash
# Check Node, install dependencies, download Electron and build node-pty
make setup

# Check Node, rebuild native modules, then start in development mode (hot reload)
make dev
```

Unit tests (`pnpm test`) never download Electron.

### Setup troubleshooting

- `ERR_PNPM_BAD_PM_VERSION`, a verify-deps failure, or "Multiple versions of pnpm specified": run `corepack enable`, then rerun.
- `Error: python3 not found` (or make/g++) from `make rebuild-native`: install the build tools, for example `sudo apt-get install build-essential python3` or `sudo dnf install gcc-c++ make python3`.
- `Failed to load native module: pty.node`: run `make rebuild-native`.
- `make rebuild-native` fails while downloading the Electron headers: check your connection to electronjs.org and run it again.
- Dependency versions follow a manual guideline of preferring releases at least ~7 days old. An urgent security fix (for example Electron) may take the newest release directly.

## Building

```bash
# Compile for production
make build

# Package for Linux
make package-deb      # .deb (Debian/Ubuntu)
make package-rpm      # .rpm (Fedora/RHEL)
make package-appimage # .AppImage (portable)
make dist             # all formats

# Single architecture (default builds every arch in electron-builder.yml)
make package-deb ARCH=x64
```

## Sandbox Sessions

A sandbox session runs Claude Code with `--dangerously-skip-permissions` inside a local Docker container, against a persistent git worktree of your workspace, behind a DNS-driven egress allowlist. Your main checkout is never mounted, so the agent works on its own branch and you review the result in the Code Explorer before merging.

### Requirements

- Linux with **Docker Engine 28 or newer**, and your user in the `docker` group (`sudo usermod -aG docker $USER`, then log in again).
- Rootless Docker and Podman are not supported in v1. The app shows the reason in Settings.
- The host `iptables` can use either backend. The image calls `iptables-nft` explicitly, and the container needs the `nf_tables`, `nft_compat` and `xt_set` kernel modules (present on current distro kernels).
- Run Claude Code on the host at least once, so `~/.claude` and `~/.claude.json` exist. Corner Office never creates them, and a sandbox is not eligible until both are there.
- The workspace must be a git repository with a base branch (for example `main`).
- A recent [Corner Office plugin](https://github.com/amerh/corner-office-plugin) for Claude Code, one that listens on `CORNER_OFFICE_CHANNEL_PORT` and honours `CORNER_OFFICE_SANDBOX=1`. Without it the terminal still works, but the badge shows "Channel: plugin update needed", and chat and permission relay are off for that session. Rix also runs in host mode instead of sandbox mode.

### First build

You can build the image in two places: in Settings, then Sandbox (in the Realm skin, open **The Armory**), or by choosing Sandbox in the Start Session chooser, which offers the build when the image is missing and shows its size, time and progress. The image is about 1.4 GB with every toolchain, the first build takes a few minutes, and it needs network access. Building never starts a session: when it finishes you get an "Image ready" notice, and you start the session yourself. Rebuild after changing the toolchains, which show as stale until you do. Containers created from an older image ask you to confirm a recreate, and show you what changed, before the next start.

### First-run prompts

The first sandbox session in a workspace asks you to trust the folder once, in the terminal. The answer is stored in the shared `~/.claude.json`, so it is a one-time step per workspace. It blocks an unattended first start.

### Troubleshooting

When a session fails to start or ends on its own, the app shows a short message. The details are in the app log, which is plain text:

- Linux: `~/.config/corner-office/logs/main.log` (the previous file is `main.old.log`).
- Sandbox lines start with `[sandbox-manager]`, `[sandbox-network]`, `[sandbox-worktree]`, `[sandbox-image]` or `[sandbox-spec]`. Lifecycle failures name the workspace, the step and the Docker cause (kind, exit code and the stderr tail), and a failed start also logs its result code, such as `FIREWALL_FAILED`.
- Settings → Sandbox shows the Docker state with a next step. After fixing it, press **Check again**.

### Accepted risks

A sandbox limits the damage an unattended agent can do. It is not a guarantee. These risks are accepted:

- `~/.claude` is mounted read-write. The agent can read and use your OAuth tokens, and could plant hooks or settings that run in your next host session.
- Allowlisted services can carry data out: GitHub, npm, PyPI and **`sentry.io`**, a general data-ingestion service. An allowlisted IP may also serve other hostnames (domain fronting, shared CDNs).
- Connections opened before you shrink the allowlist stay open until the session ends.
- **Unrestricted** network mode, chosen per session, removes the firewall.
- The agent can move or delete refs, and can delete or corrupt `.git/objects`, `packed-refs` and `logs/`, which loses unpushed history. The reflog recovers refs. It does not recover deleted objects.
- Files the agent writes on its branch (`package.json` scripts, `.husky/`, the Makefile) only run on your host once you check out or merge that branch, so review before you merge.
- Don't run `git` or git-aware tools (including your editor's git integration) inside directories the agent writes to, such as the worktree's subfolders, `.rix` or the docs folder. A nested `.git` the agent plants there can make git run code (hooks, config) on your host.
- A host Claude session in the same repo can still have its session IDs read by the sandbox agent, so it can pass its events off as host events, until directory-based provenance ships. Host IDs are only accepted for the event's own workspace.

Everything a sandbox sends to the app (chat, permission prompts, notifications, activity) is untrusted text and carries a persistent Sandbox tag.

### Crash consistency

If Corner Office quits or crashes while a session runs, the container can outlive it. At the next launch, once Docker answers, the app stops any leftover sandbox container that has no session. If a stop can't be confirmed, the workspace shows "Still stopping, retrying." and stays blocked until it is. The worktree and branch are never touched by this.

### Manual cleanup

If the app can't clean up after itself, you can remove the leftovers by hand:

```bash
docker rm -f $(docker ps -aq --filter label=co.sandbox=1)
git -C <repo> worktree unlock ~/.corner-office/sandboxes/<ws>
git -C <repo> worktree remove --force ~/.corner-office/sandboxes/<ws>
docker rmi claude-sandbox:latest
rm -rf ~/.corner-office/sandbox
```

Branches and commits live in your repository and are not affected. Worktrees the app moved aside (`<ws>.broken-<timestamp>`) are never deleted automatically.

### Developer loop

You can iterate on the Dockerfile and the firewall without the app. These are the raw commands the app runs (argv arrays, no shell), with a reduced mount set. The app also layers read-only overlays on `.git` (hooks, config, modules, `HEAD`, `index` and the worktree pointer files) and mounts the events and channel-card directories. Those protect the host, not the image, so you don't need them to test the image or the firewall.

Run the commands from the repository root, because the paths below (`resources/sandbox/Dockerfile`) are relative to it. Use a container name the app doesn't own (`sbx-dev` below, not `co-sandbox-*`), so its reconcile on startup doesn't stop your container. Close the app, or keep it away from this workspace, while you work.

```bash
SLUG=myws
REPO=/path/to/repo
WT=$HOME/.corner-office/sandboxes/$SLUG
PORT=24680
IMG=claude-sandbox-dev:latest

# 1. Build (context is resources/sandbox in a checkout)
docker build --pull \
  --tag $IMG \
  --build-arg WITH_NODE=1 --build-arg WITH_GO=1 --build-arg WITH_BUILD=1 \
  --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) --build-arg AGENT_HOME=$HOME \
  --file resources/sandbox/Dockerfile resources/sandbox

# 2. A worktree to work in (detached at the base branch, as the app does it; the agent creates its own branch)
git -C $REPO worktree add --detach -- $WT main

# 3. Create the container
docker create --name sbx-dev --hostname sbx-dev --init \
  --user $(id -u):$(id -g) \
  --cap-add NET_ADMIN --cap-add NET_RAW \
  --security-opt no-new-privileges \
  --sysctl net.ipv4.ip_unprivileged_port_start=1024 \
  --tmpfs /run:rw,nosuid,nodev,noexec,mode=0755,size=4m \
  --publish 127.0.0.1:$PORT:$PORT \
  --env HOME=$HOME --env CORNER_OFFICE_SANDBOX=1 --env CORNER_OFFICE_CHANNEL_PORT=$PORT \
  --mount type=bind,source=$HOME/.claude,target=$HOME/.claude \
  --mount type=bind,source=$HOME/.claude.json,target=$HOME/.claude.json \
  --mount type=bind,source=$REPO/.git,target=$REPO/.git \
  --mount type=bind,source=$WT,target=$WT \
  --workdir $WT \
  $IMG

# 4. Start it
docker start sbx-dev

# 5. Firewall. This MUST run before claude. Domains go on stdin, one per line.
#    Keep api.anthropic.com in the list: the script's DNS self-check resolves it (exit 3 without it) and Claude needs it.
printf '%s\n' api.anthropic.com github.com registry.npmjs.org \
  | docker exec --interactive --user root \
      --env PATH=/usr/sbin:/usr/bin:/sbin:/bin --env HOME=/root \
      sbx-dev /opt/co-sandbox/init-firewall.sh allowlist

# 6. The session
docker exec --interactive --tty --user $(id -u):$(id -g) --workdir $WT \
  --env TERM=xterm-256color --env COLORTERM=truecolor --env LANG=C.UTF-8 \
  sbx-dev claude --dangerously-skip-permissions \
  --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process

# Stop and remove
docker stop --time 10 sbx-dev
docker rm --force sbx-dev
```

> **Warning:** run `init-firewall.sh` (step 5) before `claude` (step 6) every time you start the container. If you skip it, the agent runs with **unrestricted network access**, and `--dangerously-skip-permissions` means nothing asks before it uses it. The firewall rules live in the container's network namespace and are lost when the container stops, so repeat step 5 after every `docker start`. Passing `open` instead of `allowlist` also disables the firewall.

To check the firewall by hand, run `docker exec sbx-dev curl -sS --max-time 5 https://example.org` after step 5. It should fail, while a listed domain such as `https://github.com` should connect.

## Testing

```bash
# Run all tests
make test

# Watch mode
pnpm test:watch

# With coverage (85% threshold enforced by pre-commit hook)
pnpm test:coverage

# E2E tests
pnpm test:e2e
```

The Docker suite needs a local Docker Engine and is skipped unless you ask for it:

```bash
CO_DOCKER_TESTS=1 pnpm test:docker
```

It takes about 6.5 minutes, builds the `claude-sandbox:test` image and removes it afterwards. Run one suite at a time, and avoid a busy machine.

## Releases

Versioning is automated with [semantic-release](https://github.com/semantic-release/semantic-release). Every push to `main` runs the Release workflow, which reads the commits since the last `v*` tag and, if any warrant a release, tags `vX.Y.Z` and publishes a GitHub release with generated notes. Nothing is committed back to `main` (it only accepts pull requests), so the git tag is the source of truth for the version, not `package.json`. Each new release then runs the Package workflow, which builds `.deb` and `.rpm` packages for x64 and arm64 with `make package-deb package-rpm ARCH=<arch>` and attaches them to the release with a `SHA256SUMS` file. To (re)package an existing tag, run the Package workflow manually from the Actions tab.

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced locally by a commitlint `commit-msg` hook):

| Commit | Release |
|---|---|
| `fix(scope): ...` | patch (`0.2.18` → `0.2.19`) |
| `feat(scope): ...` | minor (`0.2.18` → `0.3.0`) |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major |
| `chore`, `ci`, `docs`, `refactor`, `test`, ... | no release |

PRs are squash-merged, so the **PR title** becomes the commit on `main` and must follow the same format.

## Project Structure

```
src/
  main/              # Electron main process
    ipc/             #   IPC channel definitions and handlers
    services/        #   Workspace discovery, file watching, state, terminals, channels
    types/           #   Shared type definitions
  preload/           # Preload script (sandboxed bridge)
  renderer/          # React application
    components/
      channels/      #   Chat UI for Claude sessions
      dashboard/     #   Activity feed, workspace cards
      docviewer/     #   Markdown/YAML document viewer overlay
      gamification/  #   XP, levels, achievements
      icons/         #   SVG icon components
      layout/        #   App shell, sidebars, navigation
      notifications/ #   Notification panels
      realm/         #   Medieval fantasy UI skin
      settings/      #   Settings panels, plugin status
      shared/        #   Reusable UI primitives
      terminal/      #   xterm.js terminal overlay
      workspace/     #   Workspace detail views
    stores/          #   Zustand state stores
docs/                # Pipeline documents (TODO, IN_PROGRESS, DONE)
.rix/                # Rix dev manager state (pipelines, memory, history)
assets/              # App icons and images
```

## How It Works

Corner Office reads the `.rix/` directory and `docs/` structure that the Corner Office plugin maintains in each workspace. It discovers workspaces by scanning `~/.claude/projects/` for directories containing `.rix/memory.md`.

Live session data comes through the Claude Code Channels API — the plugin exposes a WebSocket server per session, and the app connects to relay events, chat messages, and permission requests.

All IPC between main and renderer processes is validated with Zod schemas. The preload script whitelists specific channels for security.

## Plugin

This app is the companion to the [Corner Office plugin for Claude Code](https://github.com/amerh/corner-office-plugin). The plugin handles the Claude Code side (pipeline management, event emission, session channels) while this app provides the visual dashboard.

## License

MIT
