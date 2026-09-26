// Boss, 2026-09-26 (TG 6556): entering the Approvals page (menu or a link from
// a project) must show the PENDING ones by default when there are any, and
// everything only when nothing is pending. A refresh or the user's own filter
// choice is not overridden.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const fnSrc = js.match(/function approvalsEntryDefaultStatus\(list\) \{[^]*?\n\}/)![0]
// eslint-disable-next-line no-new-func
const approvalsEntryDefaultStatus = new Function(`${fnSrc}; return approvalsEntryDefaultStatus`)() as (l: unknown) => string

describe('approvals page entry filter', () => {
  it('pending when anything is pending', () => {
    expect(approvalsEntryDefaultStatus([{ status: 'approved' }, { status: 'pending' }])).toBe('pending')
  })
  it('everything when nothing is pending (or the list is empty / unreadable)', () => {
    expect(approvalsEntryDefaultStatus([{ status: 'approved' }])).toBe('')
    expect(approvalsEntryDefaultStatus([])).toBe('')
    expect(approvalsEntryDefaultStatus(null)).toBe('')
  })
  it('applies only on page entry, not on refresh', () => {
    expect(js).toMatch(/pageId === 'approvals'\) \{ _approvalsDefaultOnEntry = true; loadApprovalsPage\(\) \}/)
    expect(js).toMatch(/if \(_approvalsDefaultOnEntry\) \{\s*_approvalsDefaultOnEntry = false\s*_setApprovalsStatusFilter\(approvalsEntryDefaultStatus\(_approvalsAll\)\)/)
    expect(js).toContain("getElementById('refreshApprovalsBtn').addEventListener('click', loadApprovalsPage)")
  })
})
