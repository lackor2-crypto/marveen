/**
 * #751 (Boss, TG 4201): the content points of the finalize check are to-dos of the work item, never a gate; only the
 * signature and the annexes ask for the owner's "finalize anyway" tick.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addTodo, listItemTodos, updateTodo } from '../workbench-todos.js'
import { CHECK_TODO_BY, applyTickedTodos, checkTodoTexts, needsOverride, syncCheckTodos } from '../workbench-check-todos.js'
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

  // #807 (Boss, Munkapad chat 2026-10-26): "tűnjön el innen a figyelmeztetés, ha ki lettek pipálva a teendőknél!"
  describe('#807 a point ticked off in the to-dos is no longer open in the check', () => {
    const refs: CheckItem = { key: 'unverified_references', ok: false, count: 2, total: 2, detail: ['§ 47 Abs. 1 OWiG', '§ 47 Abs. 1 OWiG'] }
    const quotes: CheckItem = { key: 'quotes_verified', ok: false, count: 7, total: 8, detail: ['../x.pdf:1 -- not_found'] }
    const claims: CheckItem = { key: 'unsupported_claims', ok: false, count: 2, detail: ['Erich-Steinfurth-Straße 25', 'Meine Mutter bezieht Grundsicherung'] }
    const tick = (end: string, done = true) => {
      const row = listItemTodos(itemId).find((r) => r.text.endsWith(end))!
      expect(updateTodo(row.id, { done }).ok).toBe(true)
    }

    it('nothing ticked: the check rows stay as they are', () => {
      syncCheckTodos(itemId, [refs, quotes, claims], 'hu')
      expect(applyTickedTodos(itemId, [refs, quotes, claims])).toEqual([refs, quotes, claims])
    })

    it('every point of a row ticked: the row is clear and says how many were ticked', () => {
      syncCheckTodos(itemId, [refs, quotes, claims], 'hu')
      tick('§ 47 Abs. 1 OWiG')
      tick('not_found')
      const [r, q, c] = applyTickedTodos(itemId, [refs, quotes, claims])
      expect(r).toEqual({ ...refs, ok: true, count: 0, detail: [], ticked: 2 })
      // The quote count is the number of VERIFIED quotes: it stays 7 / 8, the row is clear.
      expect(q).toEqual({ ...quotes, ok: true, detail: [], ticked: 1 })
      expect(c).toEqual(claims)
    })

    it('a partly ticked row stays open with the rest; un-ticking brings the point back', () => {
      syncCheckTodos(itemId, [claims], 'hu')
      tick('Grundsicherung')
      expect(applyTickedTodos(itemId, [claims])[0]).toEqual({ ...claims, count: 1, detail: ['Erich-Steinfurth-Straße 25'], ticked: 1 })
      tick('Grundsicherung', false)
      expect(applyTickedTodos(itemId, [claims])[0]).toEqual(claims)
    })

    it('a to-do made in the other install language counts too; the owner\'s own to-do with the same text does not', () => {
      syncCheckTodos(itemId, [refs], 'en')
      tick('§ 47 Abs. 1 OWiG')
      expect(applyTickedTodos(itemId, [refs])[0]!.ok).toBe(true)
      initDatabase(':memory:')
      const p = createProject({ name: 'Próba' })
      if (!p.ok) throw new Error('project')
      const w = createWorkItem({ project_id: p.project.id, title: 'Levél', type: 'document' })
      if (!w.ok) throw new Error('item')
      const own = addTodo({ work_item_id: w.item.id, text: 'Hivatkozás ellenőrzése: § 47 Abs. 1 OWiG', by: 'tulaj', source: 'owner' })
      if (!own.ok) throw new Error('todo')
      expect(updateTodo(own.todo.id, { done: true }).ok).toBe(true)
      expect(applyTickedTodos(w.item.id, [refs])[0]).toEqual(refs)
    })

    it('the ticked points are not made again and stay ticked after the next sync', () => {
      syncCheckTodos(itemId, [refs], 'hu')
      tick('§ 47 Abs. 1 OWiG')
      const shown = applyTickedTodos(itemId, [refs])
      expect(syncCheckTodos(itemId, shown, 'hu')).toBe(0)
      expect(listItemTodos(itemId).map((r) => r.done_at != null)).toEqual([true])
    })
  })

  it('#807 the page: ticked count shown (HU+EN), the check refreshed after a tick, the to-dos reloaded on every view', () => {
    const js = readFileSync(new URL('../../web/workbench.js', import.meta.url), 'utf-8')
    expect(js).toContain("t('workbench.outline.check.ticked', { n: i.ticked })")
    expect(js).toMatch(/toastKey !== 'add' && WB\.detail && WB\.detail\.outline\) refreshOutline\(\)/)
    const render = js.slice(js.indexOf('  function render() {'), js.indexOf('  function render() {') + 600)
    expect(render).toContain('syncCheckTodosSeen(WB.detail && WB.detail.outline)')
    for (const lang of ['hu', 'en']) {
      expect(readFileSync(new URL(`../../web/lang/${lang}.js`, import.meta.url), 'utf-8')).toContain('"workbench.outline.check.ticked"')
    }
  })
})
