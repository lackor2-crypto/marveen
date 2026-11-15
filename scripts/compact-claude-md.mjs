#!/usr/bin/env node
// Startup-context diet (#799): CLI around src/web/claude-md-compact.ts (the
// dashboard runs the same code on every start). Needs a built dist/.
// Usage: node scripts/compact-claude-md.mjs <CLAUDE.md> [--prefix main] [--dry-run]
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { compactClaudeMdFile } = await import(join(root, 'dist', 'web', 'claude-md-compact.js'))
const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (!file) { console.error('usage: compact-claude-md.mjs <CLAUDE.md> [--prefix main] [--dry-run]'); process.exit(2) }
const pi = args.indexOf('--prefix')
const r = compactClaudeMdFile(file, pi >= 0 ? args[pi + 1] : 'main', { dryRun: args.includes('--dry-run') })
console.log(r ? `${file}: ${r.before} -> ${r.after} bytes, ${r.moved} sections moved` : `${file}: unreadable`)
