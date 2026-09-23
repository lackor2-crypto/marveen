// EGY PROJEKT = EGY KARTYA (Boss, 2026-09-23). A #336 Munkapad-projekt het
// kartyara szabdalva allt a tablan; a tulajdonosnak kellett kezzel
// osszeszednie. A szabaly a LETREHOZAS pontjan el (kanban-create.ts), tehat a
// dashboard, az API es a Munkapad agense is ugyanabba utkozik.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, createLabel, getKanbanCard, listKanbanCards } from '../db.js'
import { createCardWithRules, SEPARATE_PROJECT_MIN_CHARS } from '../kanban-create.js'
import { applyCardLabels } from '../web/kanban-labels.js'

beforeEach(() => {
  initDatabase(':memory:')
  createLabel({ id: 'aaaa1111', name: 'marveen_fejlesztese', color: '#3b82f6' })
  createKanbanCard({ id: 'e0e0e001', title: 'AI Munkapad', status: 'waiting' } as any)
  applyCardLabels('e0e0e001', ['aaaa1111'])
  createKanbanCard({ id: 'd0d0d001', title: 'Regi lezart munka', status: 'done' } as any)
})

const base = { labels: ['marveen_fejlesztese'], status: 'planned' }

describe('egy projekt = egy kartya', () => {
  it('nyitott kartyahoz kapcsolodo uj kartya NEM jon letre, es megmondja, hol dolgozzon', () => {
    const before = listKanbanCards().length
    const r = createCardWithRules({ ...base, title: 'PDF elonezet', related: ['e0e0e001'] })
    expect(r.ok).toBe(false)
    if (!r.ok && r.code === 'same_project') {
      expect(r.cards.map((c) => c.id)).toEqual(['e0e0e001'])
      expect(r.error).toContain('EGY PROJEKT = EGY KARTYA')
      expect(r.error).toContain('/api/kanban/<id>/comments')
      expect(r.error).toContain('separate_project')
    } else {
      throw new Error('same_project kellett: ' + JSON.stringify(r))
    }
    expect(listKanbanCards().length).toBe(before)
  })

  it('a leirasban hivatkozott nyitott kartya ugyanigy szamit', () => {
    const r = createCardWithRules({ ...base, title: 'Rajzvaszon huzogatas', description: 'Folytatas: e0e0e001' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('same_project')
  })

  it('LEZART kartyahoz kapcsolodo uj munka letrejohet (az mar nem ugyanaz a nyitott projekt)', () => {
    const r = createCardWithRules({ ...base, title: 'Uj munka', related: ['d0d0d001'] })
    expect(r.ok).toBe(true)
  })

  it('related: [] (nincs kapcsolat) tovabbra is letrejon', () => {
    const r = createCardWithRules({ ...base, title: 'Teljesen mas', related: [] })
    expect(r.ok).toBe(true)
  })

  it('alfeladat (parent_id) megengedett: a szulo kartyaban jelenik meg, nem szabdalas', () => {
    const r = createCardWithRules({ title: 'PDF elonezet', parent_id: 'e0e0e001', related: ['e0e0e001'] })
    expect(r.ok).toBe(true)
  })

  it('tul rovid indok nem indok', () => {
    const r = createCardWithRules({ ...base, title: 'PDF elonezet', related: ['e0e0e001'], separate_project: 'mas' })
    expect(r.ok).toBe(false)
  })

  it('kimondott indokkal letrejon, es az indok a leirasba kerul', () => {
    const reason = 'kulon ugyfel, kulon szamlazas, mas hataridovel'
    expect(reason.length).toBeGreaterThanOrEqual(SEPARATE_PROJECT_MIN_CHARS)
    const r = createCardWithRules({ ...base, title: 'Masik ugyfel munkapadja', related: ['e0e0e001'], separate_project: reason })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const card = getKanbanCard(r.id)
      expect(card?.description).toContain(`Onallo projekt, mert: ${reason}`)
      expect((card as any)?.separate_project).toBeUndefined()
    }
  })
})
