import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-trash-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-tstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { renameLife, trashLife, explorerRoot } = await import('../life-explorer.js')
const { lifeName } = await import('../life-tree.js')
const { reposInside } = await import('../git-guard.js')

const root = explorerRoot() as string

// ONVEDELEM: inkabb ne fusson a teszt, mint hogy az eles fan dolgozzon.
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
})

describe('renameLife', () => {
  it('atnevez helyben, es a regi nev eltunik', () => {
    mkdirSync(join(root, 'Beérkező', 'regi'), { recursive: true })
    const r = renameLife('Beérkező/regi', 'uj')
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, 'Beérkező', 'uj'))).toBe(true)
    expect(existsSync(join(root, 'Beérkező', 'regi'))).toBe(false)
  })

  it('nem ir felul mar letezo nevet', () => {
    mkdirSync(join(root, 'Beérkező', 'egy'), { recursive: true })
    mkdirSync(join(root, 'Beérkező', 'ketto'), { recursive: true })
    writeFileSync(join(root, 'Beérkező', 'ketto', 'ertekes.txt'), 'ne vessz el')
    const r = renameLife('Beérkező/egy', 'ketto')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('exists')
    // a lenyeg nem a hibakod, hanem hogy a fajl megvan:
    expect(existsSync(join(root, 'Beérkező', 'ketto', 'ertekes.txt'))).toBe(true)
  })

  it('a nevbe csempeszett utvonalat elutasitja', () => {
    mkdirSync(join(root, 'Beérkező', 'x'), { recursive: true })
    const r = renameLife('Beérkező/x', '../../kiszoktem')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('bad_name')
    expect(existsSync(join(root, 'Beérkező', 'x'))).toBe(true)
  })
})

describe('trashLife', () => {
  it('a Kukaba teszi, a tartalommal egyutt — nem torli veglegesen', () => {
    mkdirSync(join(root, 'Beérkező', 'valami'), { recursive: true })
    writeFileSync(join(root, 'Beérkező', 'valami', 'a.txt'), 'megmaradok')
    const r = trashLife('Beérkező/valami')
    expect(r.ok).toBe(true)
    expect(existsSync(join(root, 'Beérkező', 'valami'))).toBe(false)
    expect(existsSync(join(root, ...r.rel.split('/'), 'a.txt'))).toBe(true)
    expect(r.rel.startsWith(lifeName('system', 'hu') + '/' + lifeName('trash', 'hu'))).toBe(true)
  })

  it('a fa fo agat nem kukazza', () => {
    mkdirSync(join(root, 'Rendszer'), { recursive: true })
    const r = trashLife('Rendszer')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('top')
    expect(existsSync(join(root, 'Rendszer'))).toBe(true)
    // az uzenet mondja is meg, hol lehet megis megszuntetni egy agat
    expect(r.message).toMatch(/Kik szerepeljenek/)
  })

  it('a fa gyokeret nem kukazza', () => {
    const r = trashLife('')
    expect(r.ok).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('a depon kivulre mutato utvonalra nem nyul', () => {
    const r = trashLife('../../etc')
    expect(r.ok).toBe(false)
    expect(existsSync(root)).toBe(true)
  })
})

/**
 * A 2026-08-22-i hatasvizsgalat leletei. Mindharom MERVE derult ki, nem
 * atgondolva -- ezert all itt mindharomra teszt.
 */
describe('a Kuka hatarai', () => {
  it('ket azonos nevu fajl UGYANABBAN a masodpercben sem irja felul egymast', () => {
    mkdirSync(join(root, 'Beérkező', 'a'), { recursive: true })
    mkdirSync(join(root, 'Beérkező', 'b'), { recursive: true })
    writeFileSync(join(root, 'Beérkező', 'a', 'x.txt'), 'ELSO')
    writeFileSync(join(root, 'Beérkező', 'b', 'x.txt'), 'MASODIK')

    const r1 = trashLife('Beérkező/a/x.txt')
    const r2 = trashLife('Beérkező/b/x.txt')
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r2.rel).not.toBe(r1.rel)
    // a lenyeg: MINDKET tartalom megvan
    expect(readFileSync(join(root, ...r1.rel.split('/')), 'utf8')).toBe('ELSO')
    expect(readFileSync(join(root, ...r2.rel.split('/')), 'utf8')).toBe('MASODIK')
    // a kiterjesztes a nev vegen marad
    expect(r2.rel.endsWith('.txt')).toBe(true)
  })

  it('a Kukat nem teszi bele sajat magaba, es ezt emberi mondatban mondja', () => {
    mkdirSync(join(root, 'Beérkező', 'q'), { recursive: true })
    trashLife('Beérkező/q')          // hogy legyen mar Kuka
    const r = trashLife(lifeName('system', 'hu') + '/' + lifeName('trash', 'hu'))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('in_trash')
    expect(r.message).not.toMatch(/EINVAL/)
  })
})

describe('reposInside', () => {
  it('megtalalja a mappa alatt levo repokat, es a repon belul nem keres tovabb', () => {
    mkdirSync(join(root, 'Rendszer', 'Tárolók', 'Git', 'fiok', 'repo1', '.git'), { recursive: true })
    mkdirSync(join(root, 'Rendszer', 'Tárolók', 'Git', 'fiok', 'repo1', 'melyen', '.git'), { recursive: true })
    mkdirSync(join(root, 'Rendszer', 'Tárolók', 'Git', 'fiok', 'nem_repo'), { recursive: true })
    const l = reposInside('Rendszer/Tárolók/Git/fiok')
    expect(l).toEqual(['Rendszer/Tárolók/Git/fiok/repo1'])
  })

  it('repo nelkuli mappara ures', () => {
    mkdirSync(join(root, 'Beérkező', 'sima'), { recursive: true })
    expect(reposInside('Beérkező/sima')).toEqual([])
  })
})
