// Fork companion of upstream quarantine-reader-render-path.test.ts (#413).
// Rebuilt from upstream 10e120ef / c2bce828 with one deliberate difference: this
// fork does not delete the old user-scope copy (~/.claude/agents), so the
// upstream "legacy cleanup" cases are replaced by the opposite pin below.
// EGRESSRENDER824: an operator grant typed into store/egress-allowlist.json
// silently never reached the quarantine-reader, and the denial looked exactly
// like a legitimate block (prompt-level rejection, no network call, nothing in
// egress-blocked.log). Two independent causes, both measured 2026-08-24 with
// positive AND negative controls:
//
//   1. TARGET PATH: the main agent's rendered copy went to the USER scope
//      (~/.claude/agents), which the runtime caches at session start. A
//      PROJECT-scoped copy is read from disk at each sub-agent spawn -- the
//      fleet agents were already project-scoped, which is why their grants
//      landed without restart while the main agent's did not.
//   2. RENDER TRIGGER: the copies were rendered only at scaffold time, so a
//      JSON edit between boots reached the HOOK (live read) but not the
//      PROMPT copies.
//
// These tests pin the target path and the watcher's re-render decision.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  quarantineReaderDestDir,
  ensureQuarantineReader,
  watchEgressAllowlistForReaderRender,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'

const TEMPLATE = `---
name: quarantine-reader
---

## Domain restriction

Only fetch URLs from these approved domains. Reject all others:
- \`status.anthropic.com\`

For any other domain, return the error shape.
`

function tmpSetup() {
  const root = mkdtempSync(join(tmpdir(), 'qr-render-'))
  const tplPath = join(root, 'quarantine-reader.md')
  writeFileSync(tplPath, TEMPLATE)
  const destDir = join(root, 'dest', '.claude', 'agents')
  const legacyPath = join(root, 'legacy', 'quarantine-reader.md')
  const storeDir = join(root, 'store')
  mkdirSync(storeDir, { recursive: true })
  return { root, tplPath, destDir, legacyPath, storeDir }
}

describe('quarantineReaderDestDir (EGRESSRENDER824 target path)', () => {
  it('the MAIN agent copy goes to PROJECT scope, never the user scope', () => {
    const dest = quarantineReaderDestDir(MAIN_AGENT_ID)
    expect(dest).toBe(join(PROJECT_ROOT, '.claude', 'agents'))
    // The load-bearing negative: the old location must be gone for good. A
    // user-scoped definition is cached at session start, so a grant written
    // there waits for a full session restart -- the measured failure.
    expect(dest.startsWith(join(homedir(), '.claude'))).toBe(false)
  })

  it('sub-agent copies stay project-scoped under their own agent dir', () => {
    const dest = quarantineReaderDestDir('samu')
    expect(dest).toContain(join('agents', 'samu', '.claude', 'agents'))
    expect(dest.startsWith(join(homedir(), '.claude', 'agents'))).toBe(false)
  })
})

describe('ensureQuarantineReader in this fork: the user-scope copy is NOT deleted', () => {
  it('writes the project copy and leaves an existing user-scope file alone', () => {
    const { tplPath, destDir, legacyPath, storeDir } = tmpSetup()
    mkdirSync(join(legacyPath, '..'), { recursive: true })
    writeFileSync(legacyPath, 'owner interactive copy')
    expect(ensureQuarantineReader(MAIN_AGENT_ID, { tplPath, destDir, storeDir })).toBe(true)
    expect(existsSync(join(destDir, 'quarantine-reader.md'))).toBe(true)
    expect(readFileSync(legacyPath, 'utf-8')).toBe('owner interactive copy')
  })

  it('an up-to-date copy is not rewritten (returns false)', () => {
    const { tplPath, destDir, storeDir } = tmpSetup()
    expect(ensureQuarantineReader(MAIN_AGENT_ID, { tplPath, destDir, storeDir })).toBe(true)
    expect(ensureQuarantineReader(MAIN_AGENT_ID, { tplPath, destDir, storeDir })).toBe(false)
  })

  it('an owner-granted domain in egress-allowlist.json reaches the rendered copy', () => {
    const { tplPath, destDir, storeDir } = tmpSetup()
    writeFileSync(join(storeDir, 'egress-allowlist.json'), JSON.stringify({ domains: ['example.org'] }))
    ensureQuarantineReader('samu', { tplPath, destDir, storeDir })
    expect(readFileSync(join(destDir, 'quarantine-reader.md'), 'utf-8')).toContain('example.org')
  })
})

describe('watchEgressAllowlistForReaderRender (the re-render decision)', () => {
  it('a JSON change re-renders MAIN + every listed agent and reports which were written', async () => {
    const { storeDir } = tmpSetup()
    const allowlistPath = join(storeDir, 'egress-allowlist.json')
    writeFileSync(allowlistPath, JSON.stringify({ quarantine_domains: [] }))

    const ensured: string[] = []
    const reported: string[][] = []
    const stop = watchEgressAllowlistForReaderRender(
      () => ['samu', 'geri'],
      (agents) => reported.push(agents),
      {
        storeDir,
        intervalMs: 20,
        ensure: (name) => {
          ensured.push(name)
          // 'geri' simulates an already-up-to-date copy: rendered=false, so it
          // must be ensured but NOT reported as written.
          return name !== 'geri'
        },
      },
    )
    try {
      // Let the poller take its baseline, then change the file.
      await new Promise((r) => setTimeout(r, 60))
      writeFileSync(allowlistPath, JSON.stringify({ quarantine_domains: ['supabase.com'] }))
      await new Promise((r) => setTimeout(r, 250))
    } finally {
      stop()
    }

    expect(ensured).toContain(MAIN_AGENT_ID)
    expect(ensured).toContain('samu')
    expect(ensured).toContain('geri')
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]).toEqual([MAIN_AGENT_ID, 'samu'])
  })

  it('one agent throwing does not stop the rest (per-agent best effort)', async () => {
    const { storeDir } = tmpSetup()
    const allowlistPath = join(storeDir, 'egress-allowlist.json')
    writeFileSync(allowlistPath, JSON.stringify({ quarantine_domains: [] }))

    const ensured: string[] = []
    const stop = watchEgressAllowlistForReaderRender(
      () => ['bad', 'good'],
      undefined,
      {
        storeDir,
        intervalMs: 20,
        ensure: (name) => {
          if (name === 'bad') throw new Error('one bad agent dir')
          ensured.push(name)
          return true
        },
      },
    )
    try {
      await new Promise((r) => setTimeout(r, 60))
      writeFileSync(allowlistPath, JSON.stringify({ quarantine_domains: ['example.org'] }))
      await new Promise((r) => setTimeout(r, 250))
    } finally {
      stop()
    }
    expect(ensured).toContain('good')
  })
})
