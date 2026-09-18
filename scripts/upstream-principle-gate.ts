#!/usr/bin/env tsx
// CLI for the upstream principle gate. Reviews incoming upstream COMMITS against
// the baked principle checklist + the committed denylist, BEFORE a merge/install.
// All logic lives in src/ (type-checked, tested); this file only wires git + I/O.
//
// Usage:
//   tsx scripts/upstream-principle-gate.ts [--upstream <ref>] [--base <ref>] [--json]
//
// Default range: the same one the dashboard's "what changed upstream" list shows
// (src/upstream-refs.ts: upstream/HEAD or upstream/main, measured from before any
// reverted upstream merge).
//
// Exit codes (by MEANING):
//   0  reviewed, fully clean (nothing excluded, nothing to discuss)
//   1  reviewed, at least one commit EXCLUDED (a merge step must stop)
//   2  could NOT review (missing ref, bad denylist, bad argument, ANY crash) --
//      this is NOT "0 exclusions"
//   3  reviewed, no exclusions but commits to DISCUSS (owner decides first)

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGate, parseDenylist, type Denylist } from '../src/upstream-principle-gate.js'
import { gatherCommits } from '../src/upstream-principle-gate-git.js'
import { resolveUpstreamRef, upstreamBase } from '../src/upstream-refs.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DENYLIST_PATH = resolve(REPO_ROOT, 'governance/upstream-exclusions.json')
const wantJson = process.argv.includes('--json')

class CannotReview extends Error {}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Value of a flag; a flag given without a value is an error, not "use the default". */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) throw new CannotReview(`${name} needs a value`)
  return v
}

function loadDenylist(): Denylist {
  let raw: string
  try {
    raw = readFileSync(DENYLIST_PATH, 'utf8')
  } catch (e) {
    // The denylist ships with the repo; missing is an error, not "nothing excluded".
    throw new CannotReview(`denylist not readable at governance/upstream-exclusions.json: ${(e as Error).message}`)
  }
  try {
    return parseDenylist(JSON.parse(raw))
  } catch (e) {
    throw new CannotReview(`denylist invalid: ${(e as Error).message}`)
  }
}

function verify(ref: string): string {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim()
  } catch {
    throw new CannotReview(`cannot resolve ref '${ref}' -- run 'git fetch upstream' first. A missing ref is NOT "nothing to review".`)
  }
}

function main(): number {
  const denylist = loadDenylist()
  const upstreamName = arg('--upstream') ?? resolveUpstreamRef(git)
  if (!upstreamName) throw new CannotReview("no upstream branch (no 'upstream' remote, or not fetched). Nothing was reviewed.")
  const upstream = verify(upstreamName)
  const baseArg = arg('--base')
  const base = baseArg ? verify(baseArg) : upstreamBase(git, 'HEAD', upstream)
  const report = runGate(gatherCommits(git, base, upstream), denylist)

  if (wantJson) {
    console.log(JSON.stringify({ ok: true, upstream: upstreamName, base, ...report }, null, 2))
  } else {
    console.log(`Upstream principle gate -- ${upstreamName}, ${report.reviewed} commit(s) from ${base.slice(0, 8)}`)
    console.log(`  EXCLUDE (auto): ${report.exclude.length}`)
    console.log(`  DISCUSS (owner decides): ${report.discuss.length}`)
    console.log(`  ALLOW: ${report.allow.length}`)
    for (const [title, list] of [['Excluded', report.exclude], ['To discuss', report.discuss]] as const) {
      if (!list.length) continue
      console.log(`\n${title}:`)
      for (const v of list) console.log(`  ${v.sha.slice(0, 8)} [${v.principleId}] ${v.subject}${v.evidence && v.evidence !== 'subject' ? `\n      at ${v.evidence}` : ''}`)
    }
    if (report.splitFiles.length) {
      console.log('\nFiles touched by both an excluded and a kept commit (a plain merge cannot separate them):')
      for (const p of report.splitFiles) console.log(`  ${p}`)
    }
  }
  return report.exclude.length > 0 ? 1 : report.discuss.length > 0 ? 3 : 0
}

// Every failure -- expected or not -- exits 2. Node's default for an uncaught
// throw is 1, which here MEANS "exclusions found"; a crash must never read as a verdict.
let code: number
try {
  code = main()
} catch (e) {
  const msg = e instanceof CannotReview ? e.message : `unexpected error: ${(e as Error)?.stack ?? String(e)}`
  if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }))
  else console.error(`upstream-principle-gate: ${msg}`)
  code = 2
}
process.exit(code)
