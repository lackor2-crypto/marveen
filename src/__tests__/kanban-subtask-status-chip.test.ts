import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #707: every subtask listed under its parent names its own column, in both lists.
describe('kanban subtask column chip', () => {
  const app = readFileSync(join(__dirname, '../../web/app.js'), 'utf8')
  const fn = app.slice(app.indexOf('function subtaskStatusChip'), app.indexOf('function createCardEl'))

  it('is built from the translated column name', () => {
    expect(fn).toContain("t('kanban.col.' + c.status)")
    expect(fn).toContain('escapeHtml')
  })
  it('is used by the other-column list and by the embedded list', () => {
    expect(app.match(/\$\{subtaskStatusChip\(c\)\}/g)?.length).toBe(2)
  })
  it('has the column names in both languages', () => {
    for (const l of ['hu', 'en']) {
      const lang = readFileSync(join(__dirname, `../../web/lang/${l}.js`), 'utf8')
      for (const s of ['planned', 'in_progress', 'testing', 'waiting', 'done']) expect(lang).toContain(`'kanban.col.${s}'`)
    }
  })
})
