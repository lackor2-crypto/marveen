// #390: the owner scan of the abandoned-worktree check used to read the whole
// audit log (16.7 MB, 27k lines) and run 2 regexes x 73 worktrees on every
// line, synchronously, on every SessionStart -- measured 1-3 s with the whole
// dashboard frozen (live CPU profile, 2026-09-25 14:19:03, a 3.26 s stall).
//
// What must hold:
//   - the name-index prefilter gives exactly the same owners as testing every
//     worktree on every line (a mix of strong/weak evidence, creation commands,
//     paths outside .worktrees/, look-alike names),
//   - the incremental file reader reads only what was appended, keeps a
//     half-written last line back, starts over on rotation or a changed
//     worktree set, and a missing log is "nobody", not a failure,
//   - the live wiring uses it, and the full scan yields to the event loop.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attributeOwners, ownerScanner, ownersFromAuditFile, _resetAuditScanMemoForTest,
} from '../web/abandoned-worktrees.js'

const REPO = join(__dirname, '..', '..')
const L = (o: Record<string, unknown>) => JSON.stringify(o)
const WT = ['/r/.worktrees/a', '/r/.worktrees/ab', '/r/.worktrees/a.b', '/x/claw', '/y/.worktrees/a']
const AG = ['alpha', 'beta', 'gamma']

/** The pre-#390 algorithm: every worktree tested on every line. */
function reference(text: string, paths: string[], agents: string[]): Map<string, string | null> {
  const strong = new Map<string, string | null>(paths.map((p) => [p, null]))
  const weak = new Map<string, string | null>(paths.map((p) => [p, null]))
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const count = new Map<string, number>()
  for (const p of paths) { const b = p.split('/').pop()!; count.set(b, (count.get(b) ?? 0) + 1) }
  for (const line of text.split('\n')) {
    let rec: Record<string, string>
    try { rec = JSON.parse(line) } catch { continue }
    const who = rec.session_agent ?? rec.agent
    if (!who || !agents.includes(who)) continue
    const t = rec.target ?? ''
    for (const p of paths) {
      const b = p.split('/').pop()!
      const created = count.get(b) === 1 && new RegExp(`agent-worktree\\.sh\\s+["']?${esc(b)}["']?(?=$|[\\s;&|)])`).test(t)
      if ((['edit', 'write', 'delete', 'move'].includes(rec.op) && t.startsWith(p + '/')) || (rec.op === 'bash' && created)) { strong.set(p, who); continue }
      const cd = new RegExp(`\\bcd\\s+["']?(?:${esc(p)}|(?:\\S*/)?\\.worktrees/${esc(b)})(?=$|[\\s/"';&|)])`).test(t)
      if (rec.cwd === p || (rec.cwd ?? '').startsWith(p + '/') || (rec.op === 'bash' && cd)) weak.set(p, who)
    }
  }
  return new Map(paths.map((p) => [p, strong.get(p) ?? weak.get(p) ?? null]))
}

const LOG = [
  L({ agent: 'alpha', op: 'bash', target: 'cd .worktrees/ab && ls', cwd: '/r' }),
  L({ session_agent: 'beta', agent: 'a', op: 'edit', target: '/r/.worktrees/a/src/x.ts', cwd: '/r/.worktrees/a' }),
  L({ agent: 'gamma', op: 'bash', target: 'cd /r/.worktrees/a.b; git status', cwd: '/r' }),
  L({ agent: 'alpha', op: 'write', target: '/x/claw/f', cwd: '/x' }),
  L({ agent: 'gamma', op: 'bash', target: 'scripts/agent-worktree.sh claw', cwd: '/r' }),
  L({ agent: 'alpha', op: 'bash', target: 'cd .worktrees/abc && ls', cwd: '/r' }),
  L({ agent: 'nobody', op: 'edit', target: '/r/.worktrees/ab/f', cwd: '/r' }),
  L({ agent: 'beta', op: 'read', target: '/r/.worktrees/ab/f', cwd: '/r/.worktrees/ab/sub' }),
  'not json /r/.worktrees/a',
].join('\n')

describe('owner prefilter', () => {
  it('gives the same owners as testing every worktree on every line', () => {
    const got = attributeOwners(LOG, WT, AG)
    expect([...got]).toEqual([...reference(LOG, WT, AG)])
    expect(got.get('/r/.worktrees/a.b')).toBe('gamma')
    expect(got.get('/r/.worktrees/ab')).toBe('beta')
    expect(got.get('/x/claw')).toBe('gamma') // both strong: the later creation command wins
  })

  it('same answer fed line by line as in one pass', () => {
    const s = ownerScanner(WT, AG)
    for (const l of LOG.split('\n')) s.feed(l)
    expect([...s.owners()]).toEqual([...attributeOwners(LOG, WT, AG)])
  })
})

describe('incremental audit file', () => {
  let dir: string
  let f: string
  beforeEach(() => { _resetAuditScanMemoForTest(); dir = mkdtempSync(join(tmpdir(), 'aw390-')); f = join(dir, 'agent-audit.jsonl') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('missing log = nobody, not a failure', async () => {
    const r = await ownersFromAuditFile(f, WT, AG)
    expect([...r.values()].every((v) => v === null)).toBe(true)
  })

  it('reads the appended part, holds back a half-written line, matches a full scan', async () => {
    writeFileSync(f, LOG + '\n')
    expect([...(await ownersFromAuditFile(f, WT, AG))]).toEqual([...attributeOwners(LOG, WT, AG)])
    const late = L({ agent: 'alpha', op: 'edit', target: '/r/.worktrees/a/z', cwd: '/r' })
    appendFileSync(f, late.slice(0, 20))
    expect((await ownersFromAuditFile(f, WT, AG)).get('/r/.worktrees/a')).toBe('beta')
    appendFileSync(f, late.slice(20) + '\n')
    expect((await ownersFromAuditFile(f, WT, AG)).get('/r/.worktrees/a')).toBe('alpha')
    expect([...(await ownersFromAuditFile(f, WT, AG))]).toEqual([...attributeOwners(readFileSync(f, 'utf8'), WT, AG)])
  })

  it('starts over when the log shrinks (rotation) or the worktree set changes', async () => {
    writeFileSync(f, LOG + '\n')
    await ownersFromAuditFile(f, WT, AG)
    writeFileSync(f, L({ agent: 'gamma', op: 'edit', target: '/r/.worktrees/a/q', cwd: '/r' }) + '\n')
    expect((await ownersFromAuditFile(f, WT, AG)).get('/r/.worktrees/ab')).toBeNull()
    const fewer = await ownersFromAuditFile(f, ['/r/.worktrees/a'], AG)
    expect([...fewer]).toEqual([['/r/.worktrees/a', 'gamma']])
  })

  it('the returned map is a copy', async () => {
    writeFileSync(f, LOG + '\n')
    ;(await ownersFromAuditFile(f, WT, AG)).set('/x/claw', 'mutated')
    expect((await ownersFromAuditFile(f, WT, AG)).get('/x/claw')).toBe('gamma')
  })
})

describe('wiring', () => {
  it('the live deps use the incremental reader, and the first scan yields', () => {
    const src = readFileSync(join(REPO, 'src/web/abandoned-worktrees.ts'), 'utf8')
    expect(src).toContain("owners: (paths, agents) => ownersFromAuditFile(join(storeDir, 'agent-audit.jsonl'), paths, agents)")
    expect(src).toContain('await feedYielding(m.scan,')
    expect(src).toContain('setImmediate')
  })
})
