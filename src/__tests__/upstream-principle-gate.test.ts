import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyCommit,
  runGate,
  parseDenylist,
  contentSignature,
  isScannableSource,
  CONTEXT_CAP_PROACTIVE_TIER,
  EMPTY_DENYLIST,
  type CommitInput,
  type Denylist,
} from '../upstream-principle-gate.js'
import { parseLogPatch } from '../upstream-principle-gate-git.js'
import { compareFrom, resolveUpstreamRef, upstreamBase, type Git } from '../upstream-refs.js'

const D = EMPTY_DENYLIST
const ROOT = join(__dirname, '..', '..')

let n = 0
function commit(subject: string, files: Record<string, string[]> = {}): CommitInput {
  n += 1
  return { sha: `sha${n}`, subject, files: Object.entries(files).map(([path, added]) => ({ path, added })) }
}

describe('RED principles auto-exclude', () => {
  it('a subject that says it differentiates agents is excluded', () => {
    const v = classifyCommit(commit('feat: grant MAIN_ONLY tool access'), D)
    expect(v.verdict).toBe('exclude')
    expect(v.principleId).toBe('agent-equality')
  })

  it('a home-path literal in product code is excluded (real case: a shell script with a fixed home)', () => {
    const v = classifyCommit(commit('fix(fleet): progress mirror', { 'scripts/rembrandt.sh': ['BASE="/home/someuser/marveen"'] }), D)
    expect(v.verdict).toBe('exclude')
    expect(v.principleId).toBe('host-agnostic-identity')
    expect(v.evidence).toContain('scripts/rembrandt.sh')
  })

  it('the owner decided proactive context-guard features are RED (A1, 2026-09-18)', () => {
    expect(CONTEXT_CAP_PROACTIVE_TIER).toBe('red')
    for (const s of [
      'feat(context-guard): a newly created agent comes up with the guard armed',
      'feat(context-guard): idle-flush tier for heavy sessions that have gone quiet (#955)',
      'feat(context-restart-gate): proactive /clear gate with fail-closed live-work detection (#938)',
      'feat(context-restart-gate): wake the fresh session after /clear (#976)',
      // negation later in the subject must not rescue the proactive first clause
      'feat(context-guard): daily-handoff trigger tier, and drop the auto-restart handoff field that was never wired',
    ]) {
      const v = classifyCommit(commit(s), D)
      expect(v.verdict, s).toBe('exclude')
      expect(v.principleId, s).toBe('no-forced-context-cap')
    }
  })

  it('an automatic done-move in the subject is excluded, a prevention of it is not', () => {
    expect(classifyCommit(commit('feat(kanban): automatically move finished cards to done'), D).verdict).toBe('exclude')
    const guard = classifyCommit(commit('fix(kanban): prevent auto-move to done'), D)
    expect(guard.verdict).not.toBe('exclude')
  })
})

describe('FLAG: owner decides', () => {
  it('a plain fix or a settings UI of the existing opt-in guard is discussed, not excluded', () => {
    for (const s of [
      'fix(context-restart-gate): stop the blocking clock from outliving its session (#959)',
      'feat(dashboard): add per-agent context-guard UI (#902)',
      'feat(context-guard): alert after three consecutive failed rescues',
    ]) {
      const v = classifyCommit(commit(s), D)
      expect(v.verdict, s).toBe('discuss')
      expect(v.principleId, s).toBe('no-forced-context-cap')
    }
  })

  it('a repo URL literal in product code is a FLAG (upstream links its own repo on purpose)', () => {
    const v = classifyCommit(commit('feat: about box', { 'src/about.ts': ["const REPO = 'https://github.com/someone/somerepo'"] }), D)
    expect(v.verdict).toBe('discuss')
    expect(v.principleId).toBe('host-agnostic-identity')
  })

  it('a main-agent branch that decides a capability is a differentiation signal', () => {
    const v = classifyCommit(commit('feat(email-gate): thread reply capability', {
      'src/web/agent-scaffold.ts': ['return name !== MAIN_AGENT_ID && capabilities.includes(X)'],
    }), D)
    expect(v.verdict).toBe('discuss')
    expect(v.principleId).toBe('agent-differentiation-signal')
  })

  it('a main-agent branch about WHERE the agent lives is not a signal', () => {
    const v = classifyCommit(commit('fix(scaffold): claude md path', {
      'src/web/agent-scaffold.ts': ['const claudeMdPath = name === MAIN_AGENT_ID', '? join(PROJECT_ROOT, "CLAUDE.md")'],
      'src/web/channel-intake-monitor.ts': ['const names = [MAIN_AGENT_ID, ...listAgentNames().filter(n => n !== MAIN_AGENT_ID)]'],
    }), D)
    expect(v.verdict).toBe('allow')
  })

  it('touching agent-scaffold.ts alone is not a signal; touching agent-parity.ts is', () => {
    expect(classifyCommit(commit('fix: scaffold', { 'src/web/agent-scaffold.ts': ['ensureX(name)'] }), D).verdict).toBe('allow')
    expect(classifyCommit(commit('fix: parity', { 'src/agent-parity.ts': ['x'] }), D).principleId).toBe('agent-differentiation-signal')
  })

  it('new UI text without both language files is a bilingual risk; UI code without text is not', () => {
    const risky = classifyCommit(commit('fix: modal', { 'web/app.js': ["if (!confirm('Van be nem mentett szöveg')) return"] }), D)
    expect(risky.principleId).toBe('bilingual-parity-risk')
    const plain = classifyCommit(commit('fix: modal', { 'web/app.js': ['overlay.hidden = true'] }), D)
    expect(plain.verdict).toBe('allow')
    const translated = classifyCommit(commit('fix: modal', {
      'web/app.js': ["if (!confirm(t('x.y'))) return"],
    }), D)
    expect(translated.verdict).toBe('allow')
  })

  it('a new blocking feature is discussed, a protective one is allowed', () => {
    expect(classifyCommit(commit('feat(kanban): hard-gate for the heartbeat worker'), D).principleId).toBe('new-restriction')
    expect(classifyCommit(commit('feat(backup): block a write that would lose data'), D).verdict).toBe('allow')
  })

  it('protective wording does not smuggle a context cap through', () => {
    const v = classifyCommit(commit('fix(context-guard): rate-limit the rescue alert'), D)
    expect(v.verdict).toBe('discuss')
    expect(v.principleId).toBe('no-forced-context-cap')
  })
})

// Measured 2026-09-18 on the real upstream: 19 of 20 automatic exclusions came
// from places that are not product code. Each one is pinned here.
describe('real-world false positives stay allowed', () => {
  it('lock files, tests, fixtures, docs and comments are not scanned', () => {
    const cases: CommitInput[] = [
      commit('chore: deps', { 'package-lock.json': ['"funding": "https://github.com/sponsors/someone"'] }),
      commit('test: path', { 'src/__tests__/x.test.ts': ["const p = '/home/someuser/marveen/x'"] }),
      commit('test: fixture', { 'tests/fixtures/a.json': ['"/home/someuser/a"'] }),
      commit('docs: guide', { 'docs/setup.md': ['cd /home/someuser/marveen'] }),
      commit('fix: note', { 'src/a.ts': ['// the old auto-compact at 50% is gone'] }),
      commit('fix(minimax): raise the context window to the real 1M', { 'src/models.ts': ['contextWindow: 1_000_000,'] }),
      commit('test(kanban): card moved to done by the owner', { 'src/__tests__/k.test.ts': ["status: 'done'"] }),
    ]
    for (const c of cases) expect(classifyCommit(c, D).verdict, c.subject).toBe('allow')
  })

  it('isScannableSource keeps product source only', () => {
    expect(isScannableSource('src/web/a.ts')).toBe(true)
    expect(isScannableSource('scripts/x.sh')).toBe(true)
    for (const p of ['src/__tests__/a.test.ts', 'package-lock.json', 'README.md', 'docs/a.ts', 'vendor/x.js']) {
      expect(isScannableSource(p), p).toBe(false)
    }
  })
})

describe('denylist', () => {
  const deny = (entries: unknown[]): Denylist => parseDenylist({ version: 1, entries })
  const entry = { principle: 'no-forced-context-cap', note: 'owner said no', decidedAt: '2026-09-18', decidedBy: 'owner' }

  it('pathPattern, subjectPattern and contentSignature each exclude', () => {
    const c = commit('feat: thing', { 'src/web/thing.ts': ['const a = 1'] })
    expect(classifyCommit(c, deny([{ ...entry, pathPattern: 'src/**/thing.ts' }])).source).toBe('denylist')
    expect(classifyCommit(c, deny([{ ...entry, subjectPattern: '^feat: thi' }])).source).toBe('denylist')
    expect(classifyCommit(c, deny([{ ...entry, contentSignature: contentSignature(['const a = 1']) }])).source).toBe('denylist')
  })

  it('a content signature never matches an empty patch', () => {
    const empty = commit('chore: rename', { 'a.bin': [] })
    expect(classifyCommit(empty, deny([{ ...entry, contentSignature: contentSignature([]) }])).verdict).toBe('allow')
  })

  it('bad entries are rejected, never treated as empty', () => {
    expect(() => parseDenylist(null)).toThrow()
    expect(() => deny([{ ...entry, note: '' , pathPattern: 'x' }])).toThrow(/note/)
    expect(() => deny([{ ...entry, principle: 'nope', pathPattern: 'x' }])).toThrow(/unknown principle/)
    expect(() => deny([{ ...entry }])).toThrow(/pathPattern/)
    expect(() => deny([{ ...entry, subjectPattern: '(' }])).toThrow(/subjectPattern/)
  })

  it('the committed denylist parses (B2: the rule decides, no manual entries)', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'governance', 'upstream-exclusions.json'), 'utf8'))
    expect(parseDenylist(raw).entries).toEqual([])
  })
})

describe('runGate', () => {
  it('counts verdicts and names files that a plain merge cannot separate', () => {
    const bad = commit('feat(context-guard): a newly created agent comes up with the guard armed', { 'src/web/routes/agents.ts': ['armGuard()'] })
    const ok = commit('fix: agents list', { 'src/web/routes/agents.ts': ['list()'], 'src/b.ts': ['x'] })
    const r = runGate([bad, ok], D)
    expect([r.reviewed, r.exclude.length, r.allow.length]).toEqual([2, 1, 1])
    expect(r.splitFiles).toEqual(['src/web/routes/agents.ts'])
    expect(r.byPrinciple['no-forced-context-cap']).toBe(1)
  })
})

describe('parseLogPatch', () => {
  it('reads commits, files and added lines; "+++" inside a hunk is content', () => {
    const raw = [
      '\x1eaaa\x1ffeat: one',
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,2 @@',
      '+const x = 1',
      '+++ not a header',
      'diff --git a/old.ts b/old.ts',
      'deleted file mode 100644',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      '\x1ebbb\x1ffix: two',
      'diff --git a/img.png b/img.png',
      'Binary files differ',
      '',
    ].join('\n')
    const cs = parseLogPatch(raw)
    expect(cs.map((c) => c.sha)).toEqual(['aaa', 'bbb'])
    expect(cs[0].files.find((f) => f.path === 'src/a.ts')?.added).toEqual(['const x = 1', '++ not a header'])
    expect(cs[0].files.map((f) => f.path)).toContain('old.ts')
    expect(cs[1].files.map((f) => f.path)).toEqual(['img.png'])
  })
})

describe('upstream-refs', () => {
  const fakeGit = (table: Record<string, string | Error>): Git => (args) => {
    const v = table[args.join(' ')]
    if (v === undefined || v instanceof Error) throw v ?? new Error(`unexpected git ${args.join(' ')}`)
    return v
  }

  it('resolveUpstreamRef: remote HEAD, then upstream/main, else null (never a guessed branch)', () => {
    expect(resolveUpstreamRef(fakeGit({ 'symbolic-ref -q refs/remotes/upstream/HEAD': 'refs/remotes/upstream/develop\n' }))).toBe('upstream/develop')
    expect(resolveUpstreamRef(fakeGit({ 'rev-parse --verify -q refs/remotes/upstream/main': 'abc\n' }))).toBe('upstream/main')
    expect(resolveUpstreamRef(fakeGit({}))).toBeNull()
  })

  it('compareFrom steps back before a reverted upstream MERGE only', () => {
    const git = fakeGit({
      'log HEAD --format=%H --grep=This reverts commit': 'r1\nr2\n',
      'log -1 --format=%B r1': 'Revert "merge"\n\nThis reverts commit abcdef1, reversing\n',
      'log -1 --format=%P abcdef1': 'p1 p2\n',
      'merge-base --is-ancestor p2 up': '',
      'rev-parse abcdef1^1': 'before\n',
      'log -1 --format=%B r2': 'Revert "fix"\n\nThis reverts commit 0cccccc.\n',
      'log -1 --format=%P 0cccccc': 'p0\n',
      'merge-base before up': 'base\n',
    })
    expect(compareFrom(git, 'HEAD', 'up')).toBe('before')
    expect(upstreamBase(git, 'HEAD', 'up')).toBe('base')
  })
})

describe('CLI contract', () => {
  it('any crash exits 2, never 1 (1 means "exclusions found")', () => {
    const cli = readFileSync(join(ROOT, 'scripts', 'upstream-principle-gate.ts'), 'utf8')
    expect(cli).toContain('code = 2')
    expect(cli).toMatch(/needs a value/)
  })
})
