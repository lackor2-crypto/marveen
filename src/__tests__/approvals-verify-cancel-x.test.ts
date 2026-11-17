// #802 (Boss TG 3389): the red X (take back the verification) sits on EVERY verification row that has
// something to take back: still running (pending), never answered (amber noresponse) and failed (red).
// It is not shown when all that is left are pass results (nothing to take back).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const fnSrc = js.match(/function _approvalVerifyCellHtml\(a\) \{[^]*?\n\}\n/)![0]
// eslint-disable-next-line no-new-func
const cell = new Function(
  't', 'escapeAttr', 'escapeHtml', '_verifyReportText', '_verifyAgentLabel',
  `${fnSrc}; return _approvalVerifyCellHtml`,
)((k: string) => k, (s: unknown) => String(s), (s: unknown) => String(s), () => '', (s: unknown) => String(s)) as (a: unknown) => string

const row = (...statuses: string[]) => ({
  id: 'a1', agent_id: 'main',
  verifications: statuses.map((status, i) => ({ agent: `ag${i}`, status, mode: 'verify', report: '' })),
})
const hasX = (html: string) => html.includes('approvals-verify-cancel')

describe('#802: the take-back X on the Approvals verification cell', () => {
  it('shows on a pending row', () => { expect(hasX(cell(row('pending')))).toBe(true) })
  it('shows on an amber no-response row', () => { expect(hasX(cell(row('noresponse')))).toBe(true) })
  it('shows on a failed (red) row, also next to a pass', () => {
    expect(hasX(cell(row('fail')))).toBe(true)
    expect(hasX(cell(row('pass', 'fail')))).toBe(true)
  })
  it('does not show when only pass results are left, or when nothing was started', () => {
    expect(hasX(cell(row('pass')))).toBe(false)
    expect(hasX(cell({ id: 'a1', agent_id: 'main', verifications: [] }))).toBe(false)
  })
})
