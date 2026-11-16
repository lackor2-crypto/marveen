#!/usr/bin/env node
// Startup-context diet (#799): CLI around src/web/skill-desc-digest.ts (the dashboard runs the
// same code on every start for ~/.claude/skills). Needs a built dist/.
// Usage: node scripts/compact-skill-descriptions.mjs <skills-dir> [--dry-run]
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { compactSkillsDir } = await import(join(root, 'dist', 'web', 'skill-desc-digest.js'))
const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--'))
if (!dir) { console.error('usage: compact-skill-descriptions.mjs <skills-dir> [--dry-run]'); process.exit(2) }
const r = compactSkillsDir(dir, { dryRun: args.includes('--dry-run') })
console.log(`${dir}: ${r.changed} skills, ${r.saved} description chars saved${args.includes('--dry-run') ? ' (dry run)' : ''}`)
