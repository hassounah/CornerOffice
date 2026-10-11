# Agents

Each coding agent Corner Office can launch is an `AgentHandler`: a pure
descriptor (`<id>/descriptor.ts`, safe to import from the renderer) plus a main
process handler (`<id>/handler.ts`). The registry is static; there is no
runtime plugin loading.

## Layout

| File | Role |
| --- | --- |
| `types.ts`, `descriptors.ts` | Pure shared types and `AGENT_DESCRIPTORS`; derives `AgentId`, `AGENT_IDS`, `getDescriptor` |
| `handler.ts` | `AgentHandler`, `defineAgent`, `assertArgvToken`, `assertAgentEnvName` |
| `registry.ts` | `HANDLERS`, `getHandler`, `AGENT_SECRET_KEYS` |
| `<id>/descriptor.ts` | Names, capabilities, permission modes, `homeEntries`, user-facing copy |
| `<id>/handler.ts` | Host argv, optional env re-admission, optional sandbox and plugin parts |

## Adding an agent

1. Create `src/main/agents/<id>/descriptor.ts` and `<id>/handler.ts` (via `defineAgent`).
2. Register it with two lines: one in `AGENT_DESCRIPTORS` (`descriptors.ts`) and one in `HANDLERS` (`registry.ts`). The compiler enforces the second.
3. New secret env keys the agent needs: add them to `ENV_DENYLIST` in `src/main/services/env-policy.ts`, then list them in the handler's `host.envAllow`. `NODE_OPTIONS`, `LD_PRELOAD` and `ELECTRON_*` can never be re-admitted.
4. New hook names the agent emits: extend the hook enum in `event-parser`.
5. New network endpoints for the sandbox: add the hosts to `DEFAULT_ALLOWLIST`.
6. A sandbox handler needs a pinned, verified install in the `Dockerfile` and `sandbox-image.ts`.
7. Update the snapshot of the derived hidden-segment allowlist; a security review reads that diff.
8. Run `pnpm vitest run src/__tests__/agents/contract.test.ts`, then add agent-specific tests.

`defineAgent` fails at module load with a message naming the agent and the fix
when the descriptor and handler disagree (for example sandbox modes without a
`sandbox` handler, or a host argv token containing shell metacharacters).

## Worked example: Codex

Codex is the smallest real agent, and the one to copy first. An agent starts host-only; the sandbox half is a second step.

**Host half**

- `codex/descriptor.ts`: host modes `[default, auto]`, no channels, and copy for "not found", the first-run notes, "activity tracking off" and the four readiness codes.
- `codex/handler.ts`: argv `codex --no-alt-screen --no-daemon [--approve-for-me]`, `envAllow` of `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN`.
- Registered with one line in `descriptors.ts` and one in `registry.ts`.

**Sandbox half** (what a sandbox agent that shares a host home must bring)

- The descriptor lists a sandbox mode (`skip`) and `homeEntries: ['.codex']`; the contract test then requires `handler.sandbox`, and the derived hidden-segment allowlist (a security-review diff) gains `.codex`.
- `codex/sandbox-config.ts`: precreate (`O_EXCL`, no symlinks, `~/.codex` itself never created), a sanitized `config.toml` overlay, shadows for `rules`, `app-server-daemon` and `log`, a per-sandbox sqlite home, socket refusal and the readiness codes.
- `codex/guard.ts`: the host's Codex loads some files the sandbox could plant, so a sweep moves new ones into `codex-quarantine` after every confirmed stop (`prepare` opens a persisted baseline, `afterStop` closes it).
- `codex/handler.ts`: `mounts` (read-write home, read-only overlays and every pre-existing guarded file), `launch` (the sqlite home env, no daemon, no approvals: the container is the boundary), `cleanup` (never follows a link, keeps the quarantine) and `afterStop`.
- Isolation: a Codex container gets nothing of `~/.claude` except the shared `homunculus` subtree (a neutral mount, only when it is a real directory), and a Claude container gets nothing of `~/.codex`. The contract test checks this for every agent.
- Also: the pinned install in the Dockerfile and `sandbox-image.ts`, and the agent's hosts in `DEFAULT_ALLOWLIST` (`api.openai.com`, `chatgpt.com`, `auth.openai.com`).
