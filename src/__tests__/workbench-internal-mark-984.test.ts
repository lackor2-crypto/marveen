// #984 (Boss TG 7690): "internal" is a MARK on any work item, not a kind of its own.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, isInternalWork, setWorkItemInternal } from '../workbench.js'
import { finalizationState } from '../workbench-docfinal.js'
import { projectCloseCheck } from '../workbench-project-close.js'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('internal mark on any kind (#984)', () => {
  it('a document created with the mark is internal and keeps its full editor kind', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Belso jeloles teszt' }); if (!p.ok) throw new Error('project')
    const r = createWorkItem({ project_id: p.project.id, type: 'document', title: 'Belso terv', internal: true })
    if (!r.ok) throw new Error('item ' + r.code)
    expect(r.item.type).toBe('document')
    expect(r.item.editor_type).not.toBe('text')
    expect(r.item.internal).toBe(1)
    expect(isInternalWork(r.item)).toBe(true)
    expect(finalizationState(r.item).reviewed).toBe(true)
    expect(projectCloseCheck(p.project.id).items.find((i) => i.key === 'unsent')).toBeUndefined()
  })
  it('an ordinary document is not internal, and the mark switches on and off', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Kapcsolo teszt' }); if (!p.ok) throw new Error('project')
    const r = createWorkItem({ project_id: p.project.id, type: 'presentation', title: 'Dia' })
    if (!r.ok) throw new Error('item')
    expect(isInternalWork(r.item)).toBe(false)
    expect(isInternalWork(setWorkItemInternal(r.item.id, true))).toBe(true)
    expect(isInternalWork(setWorkItemInternal(r.item.id, false))).toBe(false)
  })
  it('the old internal kind stays internal and carries the mark; the migration marks existing rows', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Regi belso' }); if (!p.ok) throw new Error('project')
    const r = createWorkItem({ project_id: p.project.id, type: 'internal', title: 'Regi' })
    if (!r.ok) throw new Error('item')
    expect(r.item.internal).toBe(1)
    expect(isInternalWork(setWorkItemInternal(r.item.id, false))).toBe(true)
    expect(read('src', 'workbench.ts')).toContain("UPDATE work_items SET internal = 1 WHERE type = 'internal' AND internal IS NULL")
  })
  it('the page: a switch beside the kinds, no separate Internal button, a toggle on the item, a badge, both languages', () => {
    const js = read('web', 'workbench.js')
    expect(js).toContain("var INTAKE_UI_KINDS = INTAKE_KINDS.concat(['table'])")
    expect(js).not.toContain('intakeCreateInternal')
    expect(js).toContain('wbIntakeInternal')
    expect(js).toContain("if (intakeInternalOn()) payload.internal = true")
    expect(js).toContain("data-wb-act=\"item-internal\"")
    expect(js).toContain('wb-internal-badge')
    expect(js).toContain("'/internal', { internal: true }")
    const route = read('src', 'web', 'routes', 'workbench.ts')
    expect(route).toContain("segs[1] === 'internal'")
    expect(route).toContain("internal: body['internal'] === true")
    for (const l of ['hu', 'en']) {
      const s = read('web', 'lang', `${l}.js`)
      for (const k of ['switch', 'switch_hint', 'badge', 'badge_title', 'menu_on', 'menu_off', 'marked', 'unmarked']) expect(s).toContain(`"workbench.internal.${k}"`)
      expect(s).not.toContain('"workbench.intake.kind.internal"')
    }
  })
})
