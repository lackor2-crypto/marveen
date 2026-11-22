// Boss TG 7407/7416: an internal paper (a plan, a note to ourselves) must be closable without a letter, a PDF
// recipient, an e-mail or an "in person" step. One click marks it handled with method 'internal'.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { SENT_METHODS, cleanSentDetails, markSentManually, sentStatus, sentMarkOf } from '../workbench-docsent.js'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('internal paper closes with one click', () => {
  it('"internal" is an accepted method and survives cleaning', () => {
    expect(SENT_METHODS).toContain('internal')
    expect(cleanSentDetails({ method: 'internal' }).method).toBe('internal')
  })
  it('marking an item internal counts as handled and is remembered as internal', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Belso' }); if (!p.ok) throw new Error('project')
    const it = createWorkItem({ project_id: p.project.id, type: 'document', title: 'Mentesi terv' } as never) as any
    const id = it.item?.id ?? it.id
    markSentManually(id, 'test', { method: 'internal' })
    expect(sentStatus(id).sent).toBe(true)
    expect(sentMarkOf(id)?.method).toBe('internal')
  })
  it('the page offers the button without the sending form, and both languages have the texts', () => {
    const js = read('web', 'workbench.js')
    expect(js).toContain("var SENT_VIA = ['email', 'post', 'portal', 'in_person', 'internal']")
    expect(js).toContain("if (method === 'internal') {")
    for (const l of ['hu', 'en']) {
      const s = read('web', 'lang', `${l}.js`)
      for (const k of ['workbench.sent.method.internal', 'workbench.sent.via.internal', 'workbench.sent.internal_done']) expect(s).toContain(`"${k}"`)
    }
  })
})
