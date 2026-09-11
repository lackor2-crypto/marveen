// MEGJELENITETT MAPPANEVEK: a lemez-nev es a feluleti nev szetvalasztasa.
//
// A ket dolog, amit itt biztosra kell tudni:
//   - FRISS TELEPITESEN (nincs meg a fajl) NE talaljon ki nevet -- a valodi
//     mappanev latszik, semmi sem torik;
//   - egy serult fajl NE allitsa meg az Intezot -- inkabb nincs kulon nev.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-labels-'))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { displayLabelFor, setDisplayLabel, listDisplayLabels } = await import('../life-labels.js')

const FILE = join(store, 'life-labels.json')

beforeEach(() => {
  rmSync(FILE, { force: true })
})

describe('life-labels', () => {
  it('friss telepites (nincs fajl): nincs kitalalt nev -> a valodi nev latszik', () => {
    expect(displayLabelFor('barmi/GIT_REPOS')).toBe(null)
    expect(listDisplayLabels()).toEqual({})
  })

  it('beallit es visszaad -- a rel-normalizalassal egyutt', () => {
    const r = setDisplayLabel('Korpás László/Projektek/Marvin/Fejlesztés/GIT_REPOS', 'Marveen Repos')
    expect(r.ok).toBe(true)
    expect(displayLabelFor('Korpás László/Projektek/Marvin/Fejlesztés/GIT_REPOS')).toBe('Marveen Repos')
    // vezeto/zaro per es visszaper nem szamit
    expect(displayLabelFor('/Korpás László/Projektek/Marvin/Fejlesztés/GIT_REPOS/')).toBe('Marveen Repos')
  })

  it('ures nev = torles -> visszaall a valodi nev', () => {
    setDisplayLabel('a/b', 'Valami')
    expect(displayLabelFor('a/b')).toBe('Valami')
    const r = setDisplayLabel('a/b', '   ')
    expect(r.ok).toBe(true)
    expect(displayLabelFor('a/b')).toBe(null)
  })

  it('tul hosszu nevet nem fogad el', () => {
    const r = setDisplayLabel('a/b', 'x'.repeat(121))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('too_long')
    expect(displayLabelFor('a/b')).toBe(null)
  })

  it('ures rel-t nem fogad el', () => {
    const r = setDisplayLabel('', 'Valami')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('no_rel')
  })

  it('serult fajl: nem all meg, csak nincs kulon nev', () => {
    writeFileSync(FILE, '{ nem valid json', 'utf8')
    expect(displayLabelFor('a/b')).toBe(null)
    expect(listDisplayLabels()).toEqual({})
  })

  it('a mentett fajl a {labels:{...}} alakot hasznalja', () => {
    setDisplayLabel('x/y', 'Z')
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    expect(raw.labels['x/y']).toBe('Z')
  })
})
