// Boss (TG 1990 + 2000, A): the light-blue pending row is for real approvals
// only; approvals created by a kanban card move (kanban_done) keep the
// original warning tint, and settled rows have no tint at all.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const m = js.match(/const rowStyle = !isPending \? ''\n([^]*?)\n    const time =/)

describe('approvals table row tint', () => {
  it('has the tint rule', () => {
    expect(m).not.toBeNull()
  })
  it('kanban_done keeps the warning tint, everything else pending is info blue', () => {
    const rule = m![1]
    expect(rule).toMatch(/a\.category === 'kanban_done'\s*\?\s*'background:color-mix\(in srgb, var\(--warning\) 8%, transparent\)'\s*:\s*'background:color-mix\(in srgb, var\(--info\) 14%, transparent\)'/)
  })
  it('behaves as described for the three row kinds', () => {
    // eslint-disable-next-line no-new-func
    const tint = new Function('a', `const isPending = a.status === 'pending'\nconst rowStyle = !isPending ? ''\n${m![1]}\nreturn rowStyle`) as (a: unknown) => string
    expect(tint({ status: 'approved', category: 'email_send' })).toBe('')
    expect(tint({ status: 'pending', category: 'kanban_done' })).toContain('--warning')
    expect(tint({ status: 'pending', category: 'email_send' })).toContain('--info')
  })
})
