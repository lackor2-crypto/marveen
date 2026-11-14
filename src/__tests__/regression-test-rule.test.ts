// Kanban #839 (owner, TG 4445): every bug fix comes with a regression test in the same commit.
// The rule reaches every agent (own CLAUDE.md block, machine-wide block, per-message hook, template,
// learned rules) AND the project-chat assistants (code-bridge prompt, Workbench agent system prompt).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { buildRegressionTestBody, ensureRegressionTestSection } from '../web/agent-scaffold.js'
import { REGRESSION_TEST_CARD_RULE_EN, REGRESSION_TEST_RULE_EN } from '../regression-test-rule.js'
import { buildCodeBridgePrompt } from '../workbench-agent/code-bridge-turn.js'
import { SYSTEM_PROMPT } from '../workbench-agent/context.js'
import { PROMPT_MAX_CHARS } from '../web/code-bridge-store.js'
import { buildVerificationPrompt } from '../approval-verification-dispatch.js'
import { buildCodeTaskPreamble } from '../web/code-task-preamble.js'

const THROWAWAY = 'zz-regression-test-probe'
const read = (rel: string): string => readFileSync(join(PROJECT_ROOT, rel), 'utf-8')
afterEach(() => { rmSync(agentDir(THROWAWAY), { recursive: true, force: true }) })

describe('regression-test rule (#839)', () => {
  it('says: same commit, red without the fix, and what to do when no test is possible; no owner name or path', () => {
    const b = buildRegressionTestBody()
    expect(b).toContain('REGRESSZIOS TESZT')
    expect(b).toContain('UGYANABBAN a commitban')
    expect(b).toContain('NELKUL piros')
    expect(b).toContain('MIERT nincs teszt')
    expect(b).toContain('chat-asszisztensei')
    expect(b).not.toContain('Boss')
    expect(b).not.toContain('/home/')
  })

  it('is appended once, idempotently; skips the main agent and agents without CLAUDE.md', () => {
    const dir = agentDir(THROWAWAY)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'CLAUDE.md')
    expect(ensureRegressionTestSection(THROWAWAY)).toBe('no-file')
    writeFileSync(path, '# probe\n\nSajat.\n')
    expect(ensureRegressionTestSection(THROWAWAY)).toBe('written')
    const once = readFileSync(path, 'utf-8')
    expect(once).toContain('regression-test-rule')
    expect(once.startsWith('# probe\n\nSajat.')).toBe(true)
    expect(ensureRegressionTestSection(THROWAWAY)).toBe('current')
    expect(readFileSync(path, 'utf-8')).toBe(once)
    expect(ensureRegressionTestSection(MAIN_AGENT_ID)).toBe('skipped-main')
  })

  it('is wired for the whole fleet: dashboard start, agent start, machine-wide file, hook, template, learned rules', () => {
    const web = read('src/web.ts')
    expect(web).toContain('ensureRegressionTestSection(agentName)')
    expect(web).toContain('ensureGlobalRegressionTestRule()')
    expect(read('src/web/agent-process.ts')).toContain('ensureRegressionTestSection(name)')
    expect(read('scripts/hooks/fresh-install-rule.py')).toContain('REGRESSZIOS TESZT')
    const tpl = read('templates/CLAUDE.md.template')
    expect(tpl).toContain('ensureRegressionTestSection')
    expect(tpl).toContain('REGRESSZIÓS TESZT')
    expect(read('seed-skills/marveen-learned-rules/SKILL.md')).toContain('### R40')
  })

  it('reaches the project-chat assistants: the code-bridge prompt and the Workbench agent system prompt', () => {
    for (const lang of ['hu', 'en'] as const) {
      const prompt = buildCodeBridgePrompt({ projectName: 'P', projectFolder: '/x', workItem: null, history: [], message: 'fix the button', lang })
      expect(prompt).toContain(REGRESSION_TEST_RULE_EN)
      expect(prompt.length).toBeLessThan(PROMPT_MAX_CHARS)
    }
    expect(REGRESSION_TEST_RULE_EN).toMatch(/SAME commit/)
    expect(REGRESSION_TEST_RULE_EN).toMatch(/fails without the fix/)
    expect(SYSTEM_PROMPT).toContain(REGRESSION_TEST_CARD_RULE_EN)
  })

  it('a long conversation still fits the bridge prompt with the rule in it', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(3000) }))
    const prompt = buildCodeBridgePrompt({ projectName: 'P', projectFolder: '/x', workItem: null, history, message: 'm', lang: 'hu' })
    expect(prompt.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS)
    expect(prompt).toContain(REGRESSION_TEST_RULE_EN)
  })
})

describe('the prompts that DISPATCH a fix to a code session carry the rule too (#839 follow-up)', () => {
  const base = { approvalId: 'a', category: 'kanban_done', actionDescription: 'd', agent: 'code:x', ownerName: 'Boss', tokenPath: '/t', baseUrl: 'http://localhost:1' }
  it('the fix-mode approval prompt demands a regression test in the same commit; the read-only review prompt does not ask for code', () => {
    const fix = buildVerificationPrompt({ ...base, mode: 'fix' })
    expect(fix).toContain('REGRESSZIOS TESZT')
    expect(fix).toContain('UGYANABBAN a commitban')
    expect(fix).toContain('NELKUL piros')
    expect(fix).toContain('MIERT nincs teszt')
    expect(buildVerificationPrompt({ ...base, mode: 'review' })).not.toContain('REGRESSZIOS TESZT')
  })
  it('the code-bridge preface (every task, both languages) names the rule', () => {
    const hu = buildCodeTaskPreamble({ workspacePath: '', hostKind: 'unix', lang: 'hu' })
    expect(hu).toContain('REGRESSZIOS TESZT')
    expect(hu).toContain('UGYANABBAN a commitban')
    const en = buildCodeTaskPreamble({ workspacePath: '', hostKind: 'unix', lang: 'en' })
    expect(en).toContain('REGRESSION TEST')
    expect(en).toContain('SAME commit')
  })
})

describe('land-pr.sh notice for a fix without a test (#839)', () => {
  // The notice block is run on its own, in a throwaway repository: the real script would push.
  const block = (() => {
    const s = read('scripts/land-pr.sh')
    const a = s.indexOf('# --- 0/b.')
    const b = s.indexOf('# --- 1. branch felnyomasa')
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    return s.slice(a, b)
  })()
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  function run(title: string, files: string[]): string {
    const d = mkdtempSync(join(tmpdir(), 'regtest-839-'))
    dirs.push(d)
    const git = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), '1')
    git('add', '.'); git('commit', '-q', '-m', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    for (const f of files) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x') }
    git('add', '.'); git('commit', '-q', '-m', 'change')
    const script = join(d, 'block.sh')
    writeFileSync(script, `set -euo pipefail\nTITLE="$1"\n${block}\necho reached-the-push >&2\n`)
    try {
      execFileSync('bash', [script, title], { cwd: d, stdio: 'pipe' })
      return ''
    } catch (e) {
      throw new Error('the notice block must never stop the landing: ' + String((e as { stderr?: Buffer }).stderr))
    } finally {
      // stderr of a successful run is read below
    }
  }
  function stderrOf(title: string, files: string[]): string {
    const d = mkdtempSync(join(tmpdir(), 'regtest-839-'))
    dirs.push(d)
    const git = (...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.org', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(d, 'a.txt'), '1')
    git('add', '.'); git('commit', '-q', '-m', 'base')
    git('update-ref', 'refs/remotes/origin/main', 'HEAD')
    for (const f of files) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x') }
    git('add', '.'); git('commit', '-q', '-m', 'change')
    const script = join(d, 'block.sh')
    writeFileSync(script, `set -euo pipefail\nTITLE="$1"\n${block}\necho reached-the-push >&2\n`)
    return execFileSync('bash', ['-c', 'bash "$0" "$1" 2>&1', script, title], { cwd: d, stdio: 'pipe' }).toString()
  }

  it('warns on a fix with no test file, and still goes on to the push', () => {
    const out = stderrOf('fix: the button works again (#1)', ['src/button.ts'])
    expect(out).toContain('FIGYELEM')
    expect(out).toContain('regresszios teszt')
    expect(out).toContain('reached-the-push')
    expect(run('fix: x', ['src/button.ts'])).toBe('')
  })
  it('is silent when the fix carries a test, and for a non-fix title', () => {
    const withTest = stderrOf('fix(#2): the button works again', ['src/button.ts', 'src/__tests__/button.test.ts'])
    expect(withTest).not.toContain('FIGYELEM')
    expect(withTest).toContain('reached-the-push')
    expect(stderrOf('feat: a new button', ['src/button.ts'])).not.toContain('FIGYELEM')
    expect(stderrOf('docs: notes', ['docs/a.md'])).not.toContain('FIGYELEM')
  })
})
