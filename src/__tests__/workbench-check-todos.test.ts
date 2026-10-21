/**
 * #751 (Boss, TG 4201): the content points of the finalize check are to-dos of the work item, never a gate; only the
 * signature and the annexes ask for the owner's "finalize anyway" tick.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addTodo, listItemTodos, updateTodo } from '../workbench-todos.js'
import { CHECK_TODO_BY, checkTodoTexts, needsOverride, syncCheckTodos } from '../workbench-check-todos.js'
import type { CheckItem } from '../workbench-docmodel.js'

describe('#751 check points -> to-dos', () => {
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Próba' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Levél', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })

  const variant: CheckItem = { key: 'variant_current', ok: false, count: 8, total: 10, detail: ['Új fejezet', 'A 8. ponthoz: Lakbérfizetési igazolás'] }

  it('only the signature and the annexes ask for the tick', () => {
    expect(needsOverride([variant, { key: 'missing_data', ok: false, count: 1 }])).toBe(false)
    expect(needsOverride([{ key: 'signature_missing', ok: true, count: 1 }])).toBe(true)
    expect(needsOverride([{ key: 'signature_missing', ok: true, count: 0 }])).toBe(false)
    expect(needsOverride([{ key: 'annex_missing_file', ok: false, count: 1 }])).toBe(true)
    expect(needsOverride([{ key: 'annexes', ok: true, count: 2, total: 2 }])).toBe(false)
  })

  it('one to-do per open point, in the install language; a missing-data mark keeps its own label', () => {
    expect(checkTodoTexts([variant, { key: 'missing_data', ok: false, count: 1, detail: ['⚠ Hiányzó adat: a kézbesítés dátuma'] }, { key: 'consistency', ok: true, count: 0 }], 'hu')).toEqual([
      'Nyelvi változat: fejezet fordítása: Új fejezet',
      'Nyelvi változat: fejezet fordítása: A 8. ponthoz: Lakbérfizetési igazolás',
      'Hiányzó adat: a kézbesítés dátuma',
    ])
    expect(checkTodoTexts([variant], 'en')[0]).toBe('Language version: translate the chapter: Új fejezet')
    expect(checkTodoTexts([{ key: 'signature_missing', ok: true, count: 1 }, { key: 'annex_dangling', ok: false, count: 1, detail: ['K3'] }], 'hu')).toEqual([])
  })

  it('made once; a ticked-off one is never made again; a point that went away removes its open row', () => {
    expect(syncCheckTodos(itemId, [variant], 'hu')).toBe(2)
    expect(syncCheckTodos(itemId, [variant], 'hu')).toBe(0)
    const rows = listItemTodos(itemId)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.created_by === CHECK_TODO_BY && r.source === 'agent')).toBe(true)
    // The owner says "nem kell" by ticking one off: it stays ticked and is not made again.
    const ticked = rows.find((r) => r.text.endsWith('Lakbérfizetési igazolás'))!
    expect(updateTodo(ticked.id, { done: true }).ok).toBe(true)
    expect(syncCheckTodos(itemId, [variant], 'hu')).toBe(0)
    // The chapter got translated: its open row goes, the ticked one stays the owner's.
    expect(syncCheckTodos(itemId, [{ ...variant, detail: ['A 8. ponthoz: Lakbérfizetési igazolás'] }], 'hu')).toBe(1)
    const left = listItemTodos(itemId)
    expect(left).toHaveLength(1)
    expect(left[0]!.done_at).not.toBe(null)
  })

  it('the owner\'s own to-dos are never touched', () => {
    expect(addTodo({ work_item_id: itemId, text: 'Nyelvi változat: fejezet fordítása: Új fejezet', by: 'tulaj', source: 'owner' }).ok).toBe(true)
    syncCheckTodos(itemId, [variant], 'hu')
    expect(syncCheckTodos(itemId, [], 'hu')).toBe(1)
    expect(listItemTodos(itemId).map((r) => r.created_by)).toEqual(['tulaj'])
  })
})
