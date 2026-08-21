import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
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
