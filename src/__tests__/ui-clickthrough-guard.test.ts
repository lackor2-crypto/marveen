// #763: a card whose landed work touches web/ does not reach waiting without the trace of a real-browser click-through.
import { describe, it, expect } from 'vitest'
import { checkClickthroughMove, parseGitLog, uiTouchedByCard, prNumbersFromComments, cardTouchesWebUi } from '../web/ui-clickthrough-guard.js'

const base = { prevStatus: 'in_progress', newStatus: 'waiting', agentCaller: true, uiTouched: true as boolean | null, commentTexts: [] as string[], skipReason: undefined as unknown }

describe('click-through gate (#763)', () => {
  it('refuses UI work without a click-through comment', () => {
    expect(checkClickthroughMove(base)?.error).toBe('ui_clickthrough_missing')
  })
  it('lets it through with a click-through comment (HU or EN)', () => {
    expect(checkClickthroughMove({ ...base, commentTexts: ['Böngészős végigkattintás kész'] })).toBeNull()
    expect(checkClickthroughMove({ ...base, commentTexts: ['click-through done on :3499'] })).toBeNull()
  })
  it('does not hold a server-only card, or one that could not be measured', () => {
    expect(checkClickthroughMove({ ...base, uiTouched: false })).toBeNull()
    expect(checkClickthroughMove({ ...base, uiTouched: null })).toBeNull()
  })
  it('does not ask a person in a browser session, nor moves that are not into waiting', () => {
    expect(checkClickthroughMove({ ...base, agentCaller: false })).toBeNull()
    expect(checkClickthroughMove({ ...base, newStatus: 'in_progress' })).toBeNull()
    expect(checkClickthroughMove({ ...base, prevStatus: 'waiting' })).toBeNull()
  })
  it('accepts a recorded reason of 15+ characters, not a short one', () => {
    expect(checkClickthroughMove({ ...base, skipReason: 'no screen effect at all' })).toBeNull()
    expect(checkClickthroughMove({ ...base, skipReason: 'n/a' })?.error).toBe('ui_clickthrough_missing')
  })
})

describe('reading the card\'s UI work from git', () => {
  const raw = [
    '@@COMMIT@@fix(#716): counter follows (#1387)', 'web/workbench.js', 'src/__tests__/x.test.ts',
    '@@COMMIT@@fix(#710): server only (#1378)', 'src/a.ts',
    '@@COMMIT@@docs: something (#1382)', 'web/privacy.html',
  ].join('\n')
  const commits = parseGitLog(raw)
  it('matches the card number, not the trailing PR number', () => {
    expect(uiTouchedByCard(commits, 716, new Set())).toBe(true)
    expect(uiTouchedByCard(commits, 710, new Set())).toBe(false)
    // 1387 is a PR number: card #1387 must not match it
    expect(uiTouchedByCard(commits, 1387, new Set())).toBe(false)
  })
  it('follows a PR number the card comments name', () => {
    expect(prNumbersFromComments(['landolt: PR #1382, kész', 'https://github.com/o/r/pull/1387'])).toEqual(new Set([1382, 1387]))
    expect(uiTouchedByCard(commits, 999, new Set([1382]))).toBe(true)
  })
  it('a directory that is not a git checkout is "not measured", never a fake false', () => {
    expect(cardTouchesWebUi('/nonexistent-dir-763', 1, [])).toBeNull()
  })
})

describe('land-pr.sh warns loudly on UI work (#763)', () => {
  it('prints the FELULET warning when the diff touches web/', async () => {
    const { readFileSync } = await import('node:fs')
    const sh = readFileSync(new URL('../../scripts/land-pr.sh', import.meta.url), 'utf8')
    expect(sh).toMatch(/git diff --name-only "\$MAIN_REF"\.\.\.HEAD[^\n]*grep -q '\^web\/'/)
    expect(sh).toContain('FELULET: ez a landolas a web/ mappat erinti')
  })
})
