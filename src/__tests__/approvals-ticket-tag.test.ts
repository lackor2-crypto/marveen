import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(root, 'app.js'), 'utf8')

describe('approval ticket without a kanban card (#446)', () => {
  it('tags the row and tints it when no card is linked', () => {
    expect(app).toContain('const isTicket = !_approvalKanbanCardId(a)')
    expect(app).toContain("t('approvals.ticket_tag')")
  })
  it('has the label in both languages', () => {
    for (const l of ['hu', 'en']) {
      expect(readFileSync(join(root, 'lang', `${l}.js`), 'utf8')).toContain("'approvals.ticket_tag'")
    }
  })
})
