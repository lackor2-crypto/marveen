// #378 (Boss, 2026-09-24): 6 checked mails, Törlés, 5 deleted and 1 left
// behind -- still ticked on screen. The frontend fired one /api/email/delete
// per message in parallel (six concurrent himalaya processes on one account,
// dashboard.log: `message move 112623 ... (1)`), then emptied the selection
// even for the one that failed. These pin the fix at the source level.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const app = readFileSync(join(root, 'web', 'app.js'), 'utf8')
const route = readFileSync(join(root, 'src', 'web', 'routes', 'email.ts'), 'utf8')

const handler = app.slice(app.indexOf("getElementById('emailBulkDeleteBtn')?.addEventListener"),
  app.indexOf('// Bulk "Mozgat"'))
const del = route.slice(route.indexOf("path === '/api/email/delete'"),
  route.indexOf("path === '/api/email/archive'"))

describe('email bulk delete (#378)', () => {
  it('the frontend sends one request per mailbox with all ids, not one per message in parallel', () => {
    expect(handler).toContain('body: JSON.stringify({ account: emailAccount, mailbox, ids })')
    expect(handler).not.toContain('Promise.all(')
  })

  it('what failed stays selected, so the ticked checkbox and the selection agree', () => {
    expect(handler).not.toMatch(/emailSelectedIds = new Map\(\)\n/)
    expect(handler).toContain('emailSelectedIds = new Map(entries.filter(')
    expect(handler).toContain('body.failed')
  })

  it('the server moves every id of the batch in ONE himalaya call', () => {
    expect(del).toContain("'message', 'move', ...ids,")
    expect(del).toContain("ids.join(',')")
  })

  it('the server names exactly which ids are still in place after a failure', () => {
    expect(del).toContain('messageStillExists(account, mailbox, id)')
    expect(del).toContain('failed }, 502)')
  })

  it('only the pre-command lock error is retried (himalayaRead), so nothing moves twice', () => {
    expect(del).not.toMatch(/await himalaya\(/)
    expect(del).toContain('himalayaRead(')
  })

  it('a multi-id request rejects anything but plain UIDs (no "1:*" sequence, no option injection)', () => {
    expect(del).toContain('ids.every(i => /^\\d+$/.test(i))')
  })
})
