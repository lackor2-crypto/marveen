// #973 part 2 (Boss TG 7407/7416): the "Internal work" type needs no review tick, no accept tick and no delivery step.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, isInternalWork, isTextKind, isWorkItemType, WORK_ITEM_TYPES, EDITOR_BY_TYPE } from '../workbench.js'
import { finalizationState } from '../workbench-docfinal.js'
import { projectCloseCheck } from '../workbench-project-close.js'

const root = join(__dirname, '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8')

describe('internal work type (#973 part 2)', () => {
  it('is a known type, written as text, and recognised by the helpers', () => {
    expect(isWorkItemType('internal')).toBe(true)
    expect(WORK_ITEM_TYPES).toContain('internal')
    expect(EDITOR_BY_TYPE.internal).toBe('text')
    expect(isInternalWork({ type: 'internal' })).toBe(true)
    expect(isInternalWork({ type: 'note' })).toBe(false)
    expect(isTextKind('internal')).toBe(true)
    expect(isTextKind('document')).toBe(false)
  })
  it('an internal work item can be created, reads as reviewed, and does not hold the project close', () => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Belso munka teszt' }); if (!p.ok) throw new Error('project')
    const r = createWorkItem({ project_id: p.project.id, type: 'internal', title: 'Fejlesztesi jegyzet' })
    if (!r.ok) throw new Error('item ' + r.code)
    expect(r.item.type).toBe('internal')
    expect(finalizationState(r.item).reviewed).toBe(true)
    const close = projectCloseCheck(p.project.id)
    expect(close.items.find((i) => i.key === 'unsent')).toBeUndefined()
  })
  it('the finalize gate, the page and both languages know the type', () => {
    expect(read('src', 'workbench-docfinal.ts')).toContain('isInternalWork(item)')
    const js = read('web', 'workbench.js')
    expect(js).toContain("it.internal === 1 || it.type === 'internal'")
    for (const l of ['hu', 'en']) {
      const s = read('web', 'lang', `${l}.js`)
      expect(s).toContain('"workbench.type.internal"')
      expect(s).toContain('"workbench.internal.no_ticks"')
    }
  })
})

describe('internal work needs no trigger document (#973 part 2)', () => {
  it('triggerStateOf treats an internal work as "no trigger document" and lets it finalize', async () => {
    const { triggerStateOf, finalizeNeedsTrigger } = await import('../workbench-trigger.js')
    initDatabase(':memory:')
    const p = createProject({ name: 'Trigger teszt' }); if (!p.ok) throw new Error('project')
    const base = { folder: null, container_folder: null, no_trigger: null }
    const own = triggerStateOf(p.project, { ...base, type: 'internal' })
    expect(own.noTrigger).toBe(true)
    expect(finalizeNeedsTrigger(own, false)).toBe(false)
    const doc = triggerStateOf(p.project, { ...base, type: 'document' })
    expect(finalizeNeedsTrigger(doc, false)).toBe(true)
  })
})
