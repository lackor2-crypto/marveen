// Kanban #325: amikor egy kod-hid feladat elindul (queued -> running) es van
// cardRef-je, a hivatkozott kanban kartya -- HA 'planned' -- lepjen
// 'in_progress'-be, egy rovid gepi kommenttel. Ezek a tesztek a
// promoteCardOnClaim viselkedeset rogzitik:
//   * forward-only (waiting/in_progress/done SOHA nem mozdul);
//   * fresh-install-safe (ures/ismeretlen cardRef -> csendben tovabb, nem hiba);
//   * a card_ref SZABAD SZOVEG feloldasa (8 jegyu hexa id VAGY '#sorszam').

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments } from '../db.js'
import { resetCodeBridgeTablesForTests, promoteCardOnClaim } from '../web/code-bridge-store.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('promoteCardOnClaim (#325: kod-hid task indulasakor planned -> in_progress)', () => {
  it('(a) planned kartya + cardRef -> in_progress + gepi komment (task id-vel)', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'planned card', status: 'planned' })
    promoteCardOnClaim('aaaa1111', 'task-1')
    expect(getKanbanCard('aaaa1111')?.status).toBe('in_progress')
    const comments = getKanbanComments('aaaa1111')
    expect(comments.length).toBe(1)
    expect(comments[0].author).toBe('code-bridge')
    expect(comments[0].content).toContain('task-1')
  })

  it('(b) waiting kartya + cardRef -> VALTOZATLAN (waiting), nincs komment', () => {
    // A waiting szandekos: a kimozgatasa visszavonna a tulaj fuggo jovahagyasat.
    createKanbanCard({ id: 'bbbb2222', title: 'waiting card', status: 'waiting' })
    promoteCardOnClaim('bbbb2222', 'task-2')
    expect(getKanbanCard('bbbb2222')?.status).toBe('waiting')
    expect(getKanbanComments('bbbb2222').length).toBe(0)
  })

  it('(c) nincs cardRef (null) -> semmi nem tortenik, nincs hiba', () => {
    expect(() => promoteCardOnClaim(null, 'task-3')).not.toThrow()
  })

  it('(d) ismeretlen cardRef -> nincs hiba, mas kartya erintetlen', () => {
    createKanbanCard({ id: 'cccc3333', title: 'untouched', status: 'planned' })
    expect(() => promoteCardOnClaim('nincsilyenkartya', 'task-4')).not.toThrow()
    expect(getKanbanCard('cccc3333')?.status).toBe('planned')
  })

  it('forward-only: in_progress kartyat nem mozgat es nem kommentel', () => {
    createKanbanCard({ id: 'dddd4444', title: 'already in progress', status: 'in_progress' })
    promoteCardOnClaim('dddd4444', 'task-5')
    expect(getKanbanCard('dddd4444')?.status).toBe('in_progress')
    expect(getKanbanComments('dddd4444').length).toBe(0)
  })

  it("a card_ref lehet '#sorszam' is: seq szerint oldja fel es lepteti", () => {
    createKanbanCard({ id: 'eeee5555', title: 'by seq', status: 'planned' })
    const seq = getKanbanCard('eeee5555')?.seq
    expect(typeof seq).toBe('number')
    promoteCardOnClaim(`#${seq}`, 'task-6')
    expect(getKanbanCard('eeee5555')?.status).toBe('in_progress')
  })

  it("a card_ref lehet '#' nelkuli tiszta sorszam is", () => {
    createKanbanCard({ id: 'ffff6666', title: 'by bare seq', status: 'planned' })
    const seq = getKanbanCard('ffff6666')?.seq as number
    promoteCardOnClaim(String(seq), 'task-7')
    expect(getKanbanCard('ffff6666')?.status).toBe('in_progress')
  })
})
