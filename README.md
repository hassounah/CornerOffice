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
- **Two UI skins** — Office (clean dashboard) and Realm (medieval fantasy theme with a kingdom map, wizard's study, and character sprites)

## Screenshots

*Coming soon*

## Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 41 |
| Frontend | React 19, React Router 7, Zustand 5 |
| Styling | Tailwind CSS 4, Outfit font |
| Terminal | xterm.js 6, node-pty 1.1 |
| Markdown | react-markdown 10, remark-gfm |
| Charts | Recharts 3 |
| Build | electron-vite 5, Vite 7 |
| Testing | Vitest 4, Testing Library, Playwright |
| Linting | ESLint 10 (flat config), TypeScript 5.9 |
| IPC validation | Zod 4 |

## Requirements

- Node.js 20+
- pnpm

## Getting Started

```bash
# Install dependencies
make setup

# Start in development mode (hot reload)
make dev
```

## Building

```bash
# Compile for production
make build

# Package for Linux
make package-deb      # .deb (Debian/Ubuntu)
make package-rpm      # .rpm (Fedora/RHEL)
make package-appimage # .AppImage (portable)
make dist             # all formats
```

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
