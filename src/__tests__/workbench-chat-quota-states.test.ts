// #878 (Boss TG 5512/5517): the Workbench chat has TWO quota states only: yellow warning from 95%, red at 100%.
// No machine code and no false "no AI provider" text on screen.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('Workbench chat quota states (#878)', () => {
  const js = read('web/workbench.js')
  it('the picker has a yellow dot and a caution suffix', () => {
    expect(js).toContain("s === 'caution' ? '🟡'")
    expect(js).toContain('workbench.chat.account_caution_suffix')
  })
  it('red only for the used-up frame, yellow warning from 95%, no raw blockedReason code', () => {
    expect(js).toContain("s.blockedReason === 'limit_critical'")
    expect(js).toContain('workbench.chat.quota_out')
    expect(js).toContain('s.usage.usedPct >= 95')
    expect(js).toContain('workbench.chat.quota_warn')
    expect(js).not.toContain("esc(s.blockedReason)")
  })
  it('both languages carry the new texts, and the label no longer says "kimerült"', () => {
    const hu = read('web/lang/hu.js'); const en = read('web/lang/en.js')
    for (const k of ['quota_out', 'quota_warn', 'account_caution_suffix', 'busy_blocked']) {
      expect(hu).toContain('"workbench.chat.' + k + '"')
      expect(en).toContain('"workbench.chat.' + k + '"')
    }
    expect(hu).not.toMatch(/account_limited_suffix": "\(kimerült\)"/)
  })
  it('the server stops only at 100% and keeps a limited login as "signed in"', () => {
    expect(read('src/workbench-agent/usage-manager.ts')).toContain('usage.usedPct >= 100')
    expect(read('src/workbench-agent/provider-anthropic.ts')).toContain('workbenchAccountStatuses().length')
    expect(read('src/workbench-agent/accounts.ts')).toContain('WORKBENCH_LIMIT_PCT = 100')
  })
})
