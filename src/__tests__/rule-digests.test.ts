import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentRuleBody, ruleBody, ruleDetailsDir, RULE_DIGESTS } from '../web/rule-digests.js'

describe('rule-digests (#799 regression: startup context diet)', () => {
  let home: string
  let prev: string | undefined
  beforeEach(() => { prev = process.env.HOME; home = mkdtempSync(join(tmpdir(), 'rd-')); process.env.HOME = home })
  afterEach(() => { process.env.HOME = prev; rmSync(home, { recursive: true, force: true }) })
  const FULL = '## Cim\n\n' + 'hosszu szoveg '.repeat(200)

  it('global block carries heading, digest and pointer; full text goes to the details file', () => {
    const out = ruleBody('ask-back', FULL)
    expect(out).toContain('## Cim')
    expect(out).toContain(RULE_DIGESTS['ask-back'])
    expect(out).toContain('~/.claude/rule-details/ask-back.md')
    expect(out.length).toBeLessThan(FULL.length)
    expect(readFileSync(join(ruleDetailsDir(), 'ask-back.md'), 'utf-8')).toBe(FULL + '\n')
  })

  it('agent block is only a pointer, the full text is still written', () => {
    const out = agentRuleBody('recheck', FULL)
    expect(out).toContain('globalis ~/.claude/CLAUDE.md')
    expect(out).not.toContain('hosszu szoveg')
    expect(readFileSync(join(ruleDetailsDir(), 'recheck.md'), 'utf-8')).toContain('hosszu szoveg')
  })

  it('rewrites the details file after the directory was deleted', () => {
    ruleBody('ask-back', FULL)
    rmSync(ruleDetailsDir(), { recursive: true, force: true })
    ruleBody('ask-back', FULL)
    expect(existsSync(join(ruleDetailsDir(), 'ask-back.md'))).toBe(true)
  })

  it('a key without a digest is returned unchanged', () => {
    expect(ruleBody('autonomy', FULL)).toBe(FULL)
  })
})
