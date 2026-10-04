/**
 * Kanban #484: Intezo rendezes (mappak elol), csoportositas tipus szerint,
 * mappameret aszinkron meresen at; es a szerver /api/life/dirsize vegpontja.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { lifeDirSize } from '../life-dirsize.js'

const root = resolve(import.meta.dirname, '..', '..')
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8')

function extract(name: string): string {
  const start = app.indexOf(`function ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  return app.slice(start, app.indexOf('\n}\n', start) + 2)
}

const store: Record<string, string> = {}
const t = (k: string, p?: Record<string, unknown>) => (p ? `${k}:${p.type ?? p.ext ?? ''}:${p.n ?? ''}` : k)
const names = ['_intezoSortState', '_intezoKnownDirBytes', '_intezoCompare', '_intezoOrder', '_intezoTypeText', '_intezoBytes']
// eslint-disable-next-line no-new-func
const mod = new Function('t', 'localStorage', `
  const _INTEZO_SORT_KEYS = ['name', 'modified', 'type', 'size']
  let _intezoDirSizes = {}
  ${names.map(extract).join('\n')}
  return { order: _intezoOrder, bytes: _intezoBytes, sizes: _intezoDirSizes }
`)(t, {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v },
}) as { order: (L: unknown) => { rows: Array<{ name: string }>; heads: Record<string, string> }; bytes: (n: number) => string; sizes: Record<string, unknown> }

const dir = (name: string, extra = {}) => ({ isDir: true, name, rel: name, mtime: '2026-01-01T00:00:00Z', ...extra })
const file = (name: string, size: number, mtime = '2026-01-01T00:00:00Z') => ({ isDir: false, name, rel: name, size, mtime })
const L = {
  folders: [dir('beta'), dir('alfa')],
  files: [file('b.txt', 5), file('a.pdf', 50, '2026-03-01T00:00:00Z'), file('c.txt', 20), file('d.pdf', 1)],
}
const order = () => mod.order(L).rows.map((e) => e.name)

describe('Intezo rendezes', () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k] })

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
      for (const k of ['sort_label', 'sort_dir_asc', 'sort_dir_desc', 'group_by_type', 'group_head', 'dirsize_title']) {
        expect(src, `${f}: ${k}`).toContain(`'intezo.${k}'`)
      }
    }
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
