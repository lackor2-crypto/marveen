#!/usr/bin/env node
// Print the main agent's CONFIGURED model on stdout, resolved exactly the way
// the dashboard resolves it -- or print nothing at all.
//
// Why a node helper instead of three lines of shell: the answer has three
// layers (store/config-overrides.json > .env MAIN_AGENT_MODEL >
// .claude/settings.json), and the launcher and the dashboard MUST agree on the
// order. When they drift, the dashboard shows one model while the bot starts on
// another -- and the owner is told, in writing, something untrue. Importing the
// compiled readConfiguredMainModel() keeps a single source of truth, the same
// pattern scripts/main-agent-isolated-config.mjs and vault-resolve.mjs follow.
//
// Prints NOTHING (exit 0) when nothing is configured or dist is missing, so
// scripts/channels.sh can fall back to its own shell-side resolution.
//
// Usage: node scripts/main-agent-model.mjs
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const { readConfiguredMainModel } = await import(
  join(projectRoot, 'dist', 'web', 'main-agent-model.js')
)

const model = readConfiguredMainModel(projectRoot)
if (model) process.stdout.write(model)
