---
name: claude-model-list-freshness
description: Use when a newly released Claude model (e.g. a new Sonnet/Opus/Fable version) is missing from the dashboard model dropdowns, or when touching how Marvin learns about new models. Explains the update chain (installed Claude program -> discovery -> dropdown) and how to fix it.
scope: global
---
# Claude model list freshness

## When to use
- The owner says a new Claude model is out but it is not in the model list.
- You change `src/claude-models.ts`, `src/claude-model-discovery.ts` or `src/claude-cli-updater.ts`.

## How the chain works
1. `src/claude-models.ts` is the curated list (labels, order).
2. `src/claude-model-discovery.ts` reads the INSTALLED Claude program and offers
   every model id NEWER than the curated list in the "New models" group.
3. That only works if the program itself is current. Agents run with
   `DISABLE_AUTOUPDATER=1` (concurrent self-updates once wiped the binary), and
   the `channels.sh` daily updater only reaches npm installs, not native ones
   (`~/.local/share/claude/versions/<ver>`).
4. `src/claude-cli-updater.ts` is therefore the single, serialized updater:
   - runs 3x a day (`CLAUDE_UPDATE_HOURS`, install time zone) plus once at
     startup if the last check is older than 12h;
   - native install -> `claude update`, npm install -> `npm install -g
     @anthropic-ai/claude-code@latest`, AVX-less pinned host -> never;
   - after the update it re-scans and registers the new ids so they are also
     SAVABLE without a restart;
   - state: `store/claude-cli-update.json`.
5. UI: agent settings -> Model -> "Modellek frissítése" button
   (`POST /api/models/refresh`), `GET /api/models/refresh` shows the last run.

## Procedure when a model is missing
1. `claude --version` vs `npm view @anthropic-ai/claude-code version`.
2. Check whether the newest program knows the id: `npm pack
   @anthropic-ai/claude-code-linux-x64@<ver>` into a temp dir, then
   `grep -aoE 'claude-(sonnet|opus|fable|haiku)-[0-9]+(-[0-9]+)?' package/claude | sort -u`.
3. Press the button (or `POST /api/models/refresh`); read `store/claude-cli-update.json`.
4. Give the model a proper label: add it to `CLAUDE_MODELS` (the discovery group
   only shows a machine name).

## Pitfalls
- The discovery scan is cached by program path+version+size; a stale program
  means a stale list, no matter how often you rescan.
- Never unset `DISABLE_AUTOUPDATER` for agent sessions: only the update call gets
  an env without it (`updateEnv()`).
- A discovered-but-unregistered id shows in the dropdown yet the save rejects it;
  every re-scan must call `registerDiscoveredClaudeModels`.

## Verification
- `npx vitest run src/__tests__/claude-cli-updater.test.ts`
- After a run, the new id appears in `GET /api/models/available` (`claude` or `claudeUj`).
