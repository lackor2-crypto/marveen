/**
 * Kanban #484: Intezo rendezes (mappak elol), csoportositas tipus szerint,
 * mappameret aszinkron meresen at; es a szerver /api/life/dirsize vegpontja.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { lifeDirSize, measure } from '../life-dirsize.js'

const root = resolve(import.meta.dirname, '..', '..')
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8')

function extract(name: string): string {
  const start = app.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return app.slice(start, app.indexOf('\n}\n', start) + 2)
}

const store: Record<string, string> = {}
const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${p.type ?? p.ext ?? ''}:${p.n ?? ''}` : k)
const names = ['_intezoSortState', '_intezoActiveTypeFilter', '_intezoDirSizeEntry', '_intezoKnownDirBytes', '_intezoDirSizeText',
  '_intezoCompare', '_intezoOrder', '_intezoTypeText', '_intezoBytes', '_intezoVisibleRows', '_intezoSelectRange']
type Row = { name: string; rel: string }
// eslint-disable-next-line no-new-func
const mod = new Function('t', 'localStorage', `
  const _INTEZO_SORT_KEYS = ['name', 'modified', 'type', 'size']
  let _intezoDirSizes = {}
  let _intezoTypeFilter = '', _intezoTypeFilterAt = null, _intezoPath = '', _intezoShown = null, _intezoListing = null
  const _intezoMulti = new Map()
  const _intezoMultiEntry = (e) => e
  ${names.map(extract).join('\n')}
  return {
    order: _intezoOrder, bytes: _intezoBytes, sizes: _intezoDirSizes, sizeText: _intezoDirSizeText,
    visible: _intezoVisibleRows, range: _intezoSelectRange, multi: _intezoMulti,
    set(v) {
      if ('filter' in v) { _intezoTypeFilter = v.filter; _intezoTypeFilterAt = v.at }
      if ('path' in v) _intezoPath = v.path
      if ('listing' in v) _intezoListing = v.listing
      if ('shown' in v) _intezoShown = v.shown
    },
  }
`)(t, {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
}) as {
  order: (L: unknown) => { rows: Row[]; heads: Record<string, string> }
  bytes: (n: number) => string
  sizes: Record<string, unknown>
  sizeText: (e: unknown) => string
  visible: () => Row[]
  range: (from: string, to: string, additive: boolean) => void
  multi: Map<string, Row>
  set: (v: { filter?: string; at?: string | null; path?: string; listing?: unknown; shown?: unknown }) => void
}

const dir = (name: string, extra = {}) => ({ isDir: true, name, rel: name, mtime: '2026-01-01T00:00:00Z', ...extra })
const file = (name: string, size: number, mtime = '2026-01-01T00:00:00Z') => ({ isDir: false, name, rel: name, size, mtime })
const L = {
  folders: [dir('beta'), dir('alfa')],
  files: [file('b.txt', 5), file('a.pdf', 50, '2026-03-01T00:00:00Z'), file('c.txt', 20), file('d.pdf', 1)],
}
const order = () => mod.order(L).rows.map((e) => e.name)

describe('Intezo rendezes', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    mod.set({ filter: '', at: null, path: '', listing: null, shown: null })
  })

  it('alapbeallitas: a szerver sorrendje, mappak elol', () => {
    expect(order()).toEqual(['beta', 'alfa', 'b.txt', 'a.pdf', 'c.txt', 'd.pdf'])
  })
  it('nev szerint novekvo: mappak elol, mindket resz rendezve', () => {
    store.intezoSortKey = 'name'; store.intezoSortDir = 'desc'
    expect(order()).toEqual(['beta', 'alfa', 'd.pdf', 'c.txt', 'b.txt', 'a.pdf'])
    store.intezoSortDir = 'asc'; store.intezoGroup = '1'
    expect(order().slice(0, 2)).toEqual(['alfa', 'beta'])
  })
  it('meret szerint: a mappak akkor is a fajlok elott maradnak', () => {
    store.intezoSortKey = 'size'; store.intezoSortDir = 'desc'
    expect(order()).toEqual(['alfa', 'beta', 'a.pdf', 'c.txt', 'b.txt', 'd.pdf'])
  })
  it('modositas szerint a legujabb elol', () => {
    store.intezoSortKey = 'modified'; store.intezoSortDir = 'desc'
    expect(order()[2]).toBe('a.pdf')
  })
  it('csoportositas: az azonos tipus egyutt, fejleccel az elso soron', () => {
    store.intezoGroup = '1'
    const r = mod.order(L)
    expect(r.rows.map((e) => e.name)).toEqual(['alfa', 'beta', 'a.pdf', 'd.pdf', 'b.txt', 'c.txt'])
    expect(Object.keys(r.heads)).toEqual(['alfa', 'a.pdf', 'b.txt'])
  })
  it('az archivalt tetel a rendezes utan is a sor vegen marad', () => {
    store.intezoSortKey = 'name'; store.intezoSortDir = 'desc'
    const r = mod.order({ folders: [], files: [{ ...file('z.txt', 1), archived: true }, file('a.txt', 1)] })
    expect(r.rows.map((e) => e.name)).toEqual(['a.txt', 'z.txt'])
  })
  it('meretformatum', () => {
    expect(mod.bytes(0)).toBe('0 B')
    expect(mod.bytes(1536)).toBe('1.5 KB')
    expect(mod.bytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(mod.bytes(-1)).toBe('')
  })
  it('a csoportfejlec sor nem kap data-rel-t (az info-kartya sorai koze ne keruljon)', () => {
    const fn = extract('_intezoGroupHeadHtml')
    expect(fn).not.toContain('data-rel')
  })
  it('minden uj kulcs megvan mindket nyelven', () => {
    for (const f of ['hu.js', 'en.js']) {
      const src = readFileSync(resolve(root, 'web', 'lang', f), 'utf8')
      for (const k of ['sort_label', 'sort_dir_asc', 'sort_dir_desc', 'group_by_type', 'group_head', 'dirsize_title',
        'dirsize_partial_title', 'dirsize_unknown_title', 'filter_label', 'filter_all', 'filter_title', 'filter_note', 'filter_clear']) {
        expect(src, `${f}: ${k}`).toContain(`'intezo.${k}'`)
      }
    }
  })
})

// A HIBA, AMIT EZ A KOR TALALT: a Shift-tartomany, a nyilak es a Ctrl+A a
// nyers szerver-sorrendet jartak be, mikozben a lista rendezve latszott --
// a Kukaba/athelyezes igy mas fajlokra ment, mint amik a kepernyon a ket
// kattintas kozott alltak.
describe('Intezo kijeloles a LATHATO sorrendben', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    mod.multi.clear()
    mod.set({ filter: '', at: null, path: '', listing: L, shown: null })
  })

  it('a Shift-tartomany a rendezett lista ket kattintasa kozotti elemeket jeloli ki', () => {
    store.intezoSortKey = 'size'; store.intezoSortDir = 'desc'
    // Lathato fajl-sorrend: a.pdf(50) c.txt(20) b.txt(5) d.pdf(1).
    mod.range('a.pdf', 'b.txt', false)
    expect([...mod.multi.keys()].sort()).toEqual(['a.pdf', 'b.txt', 'c.txt'])
    // A szerver-sorrendben (b, a, c, d) ugyanez a ket kattintas csak a b-t es
    // az a-t fogta volna, a c.txt kimarad. A d.pdf (lent, a tartomanyon kivul) sosem kerulhet bele.
    expect(mod.multi.has('d.pdf')).toBe(false)
  })
  it('a kirajzolt sorrendet adja vissza, ha van, kulonben ugyanazt szamolja ki', () => {
    store.intezoSortKey = 'name'; store.intezoSortDir = 'desc'
    expect(mod.visible().map((e) => e.name)).toEqual(['beta', 'alfa', 'd.pdf', 'c.txt', 'b.txt', 'a.pdf'])
    const drawn = [L.files[2]]
    mod.set({ shown: { L, rows: drawn } })
    expect(mod.visible()).toBe(drawn)
    // Egy masik listazashoz tartozo rajz nem szamit.
    mod.set({ shown: { L: { folders: [], files: [] }, rows: drawn } })
    expect(mod.visible().length).toBe(6)
  })
  it('a Ctrl+A / "Mind" csak a lathatot jeloli, a nyers listat nem jarja be', () => {
    const all = extract('_intezoMultiAll')
    expect(all).toContain('_intezoVisibleRows()')
    expect(all).not.toContain('L.files')
    expect(extract('_intezoSelectAll')).toContain('_intezoVisibleRows()')
  })
  it('a lista rajzolaskor eltarolja, amit kirajzolt', () => {
    const r = extract('_intezoRender')
    expect(r).toMatch(/_intezoShown = \{ L: L, rows: rows \}[\s\S]*if \(!rows\.length\)/)
  })
})

describe('Intezo szures tipus szerint', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k]
    mod.set({ filter: '', at: null, path: 'Dok', listing: L, shown: null })
  })

  it('csak a kivalasztott tipus marad, a rendezes megmarad', () => {
    mod.set({ filter: 'intezo.type_file_ext:PDF:', at: 'Dok' })
    expect(order()).toEqual(['a.pdf', 'd.pdf'])
    store.intezoSortKey = 'size'; store.intezoSortDir = 'asc'
    expect(order()).toEqual(['d.pdf', 'a.pdf'])
  })
  it('a mappak is szurhetok (Fajlmappa)', () => {
    mod.set({ filter: 'intezo.type_folder', at: 'Dok' })
    expect(order()).toEqual(['beta', 'alfa'])
  })
  it('a szuro a sajat mappajahoz tartozik: mashol nem rejt el semmit', () => {
    mod.set({ filter: 'intezo.type_file_ext:PDF:', at: 'Dok', path: 'Masik' })
    expect(order().length).toBe(6)
  })
  it('a felulet: valaszto, kikapcsolo gomb, rejtett elem nem marad kijelolve', () => {
    expect(readFileSync(resolve(root, 'web', 'index.html'), 'utf8'))
      .toMatch(/<select id="intezoTypeFilter"[\s\S]{0,200}data-i18n="intezo\.filter_all"/)
    expect(app).toContain("bind('intezoTypeFilter', 'change', () => _intezoSetTypeFilter(")
    const note = extract('_intezoFilterNoteHtml')
    expect(note).toContain('data-filter-clear')
    expect(note).toContain("t('intezo.filter_note'")
    const set = extract('_intezoSetTypeFilter')
    expect(set).toContain('_intezoMulti.delete(rel)')
    expect(set).toContain('_intezoClearSelection()')
    // Ha a szurt tipus eltunt a mappabol, a szuro lekapcsol (nem marad ures lista ok nelkul).
    expect(extract('_intezoSyncTypeFilter')).toContain("!counts[_intezoTypeFilter]) _intezoTypeFilter = ''")
  })
})

describe('Intezo mappameret: also korlat es ismeretlen', () => {
  const f = { isDir: true, name: 'x', rel: 'x', mtime: 'm1' }
  beforeEach(() => { for (const k of Object.keys(mod.sizes)) delete mod.sizes[k] })

  it('meres kozben …, teljes meresnel a meret', () => {
    expect(mod.sizeText(f)).toBe('…')
    mod.sizes.x = { bytes: 2048, partial: false, mtime: 'm1' }
    expect(mod.sizeText(f)).toBe('2.0 KB')
  })
  it('a reszleges meres also korlat (≥), sosem a teljes meret', () => {
    mod.sizes.x = { bytes: 5 * 1024 ** 3, partial: true, mtime: 'm1' }
    expect(mod.sizeText(f)).toBe('≥ 5.0 GB')
  })
  it('semmit sem sikerult megmerni -> ?, nem 0 B (a nulla ket dolgot jelenthet)', () => {
    mod.sizes.x = { bytes: 0, partial: true, mtime: 'm1' }
    expect(mod.sizeText(f)).toBe('?')
  })
  it('a mappa valtozasa utan a regi meres nem ervenyes', () => {
    mod.sizes.x = { bytes: 2048, partial: false, mtime: 'm0' }
    expect(mod.sizeText(f)).toBe('…')
  })
  it('ikon nezetben a mappa merete a buborekban all', () => {
    expect(extract('_intezoTileTip')).toContain('_intezoDirSizeText(e)')
    expect(extract('_intezoGridHtml')).toContain('_intezoTileTip(e)')
  })
})

describe('measure (mappameret ido-kerete)', () => {
  it('ha a du kifutott az idobol, NEM indul utana meg egy teljes bejaras', async () => {
    const r = await measure('/nincs-ilyen-mappa', 1000, async () => 'timeout' as const)
    expect(r).toEqual({ bytes: 0, partial: true })
  })
  it('a du eredmenye megy tovabb', async () => {
    const r = await measure('/x', 1000, async () => ({ bytes: 4096, partial: false }))
    expect(r).toEqual({ bytes: 4096, partial: false })
  })
  it('du nelkul (friss Windows-telepites) a bejaras a maradek idoben fut', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'dirsize-walk-'))
    try {
      writeFileSync(join(tmp, 'a.bin'), Buffer.alloc(1234))
      const r = await measure(tmp, 5000, async () => null)
      expect(r).toEqual({ bytes: 1234, partial: false })
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('lifeDirSize', () => {
  let tmp = ''
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dirsize-'))
    mkdirSync(join(tmp, 'sub'))
    writeFileSync(join(tmp, 'a.bin'), Buffer.alloc(10_000))
    writeFileSync(join(tmp, 'sub', 'b.bin'), Buffer.alloc(20_000))
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('osszeadja a belso mappak tartalmat is', async () => {
    const s = await lifeDirSize(tmp, true)
    expect(s.bytes).toBeGreaterThanOrEqual(30_000)
    expect(s.bytes).toBeLessThan(30_000 + 64 * 1024)
    expect(s.partial).toBe(false)
  })
  it('egyszerre ketszer kerve egy futast oszt meg', async () => {
    const [x, y] = await Promise.all([lifeDirSize(tmp, true), lifeDirSize(tmp, true)])
    expect(x).toBe(y)
  })
})
