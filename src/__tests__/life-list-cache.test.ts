/**
 * Kartya #387 -- az Intezo gyors megnyitasa: a kesz lista gyorsitotarbol jon,
 * de SOHA nem mutathat elavultat. Ez a teszt a "nem mutat elavultat" felet
 * meri: kivulrol (nem a Marveenen at) valtoztatott mappa, almappa, iras
 * utani eldobas, es a Frissites gomb (`fresh`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-listcache-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lcstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { listLifeCached, explorerRoot, clearContentCache, prewarmLifeListings } = await import('../life-explorer.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  clearContentCache()
})

describe('Intezo lista-gyorsitotar (#387)', () => {
  it('a masodik megnyitas a tarbol jon', () => {
    mkdirSync(join(root, 'A'))
    expect(listLifeCached('', { lang: 'hu' }).cached).toBeFalsy()
    const again = listLifeCached('', { lang: 'hu' })
    expect(again.cached).toBe(true)
    expect(again.folders.map((f) => f.name)).toContain('A')
  })

  it('kivulrol hozzaadott fajl a mappaban: nem a regi listat adja', () => {
    mkdirSync(join(root, 'A'))
    listLifeCached('A', { lang: 'hu' })
    writeFileSync(join(root, 'A', 'uj.txt'), 'x')
    const l = listLifeCached('A', { lang: 'hu' })
    expect(l.cached).toBeFalsy()
    expect(l.files.map((f) => f.name)).toContain('uj.txt')
  })

  it('kivulrol valtozott ALMAPPA: a darabszam nem marad a regi', () => {
    mkdirSync(join(root, 'A', 'B'), { recursive: true })
    const elso = listLifeCached('A', { lang: 'hu' })
    expect(elso.folders.find((f) => f.name === 'B')?.content?.files).toBe(0)
    writeFileSync(join(root, 'A', 'B', 'kep.jpg'), 'x')
    const l = listLifeCached('A', { lang: 'hu' })
    expect(l.cached).toBeFalsy()
    expect(l.folders.find((f) => f.name === 'B')?.content?.files).toBe(1)
  })

  it('egy iras (clearContentCache) eldobja a tarolt listat', () => {
    mkdirSync(join(root, 'A'))
    listLifeCached('', { lang: 'hu' })
    clearContentCache()
    expect(listLifeCached('', { lang: 'hu' }).cached).toBeFalsy()
  })

  it('a Frissites gomb (fresh) mindig ujra listaz', () => {
    listLifeCached('', { lang: 'hu' })
    expect(listLifeCached('', { lang: 'hu', fresh: true }).cached).toBeFalsy()
  })

  it('a nyelv kulon tarolodik: angol feluletre nem megy magyar sugo', () => {
    listLifeCached('', { lang: 'hu' })
    expect(listLifeCached('', { lang: 'en' }).cached).toBeFalsy()
  })

  it('nem letezo mappa: uzenet, es nem teszi el', () => {
    const l = listLifeCached('nincs-ilyen', { lang: 'hu' })
    expect(l.message).toBeTruthy()
    expect(listLifeCached('nincs-ilyen', { lang: 'hu' }).cached).toBeFalsy()
  })

  it('elomelegites: a gyoker es az elso szint elore a tarba kerul', async () => {
    mkdirSync(join(root, 'A'))
    mkdirSync(join(root, 'B'))
    expect(prewarmLifeListings('hu')).toBe(3)
    await new Promise((r) => setTimeout(r, 400))
    expect(listLifeCached('', { lang: 'hu' }).cached).toBe(true)
    expect(listLifeCached('A', { lang: 'hu' }).cached).toBe(true)
    expect(listLifeCached('B', { lang: 'hu' }).cached).toBe(true)
  })
})

describe('Intezo felulet (#387)', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
  it('iras utan a kliens tar is eldobodik', () => {
    const post = app.slice(app.indexOf('async function _depoPost('), app.indexOf('async function _depoPost(') + 900)
    expect(post).toContain('_intezoCacheClear()')
  })
  it('lassu valasznal konnyu lista rajzol elore, frissitesnel friss lista jon', () => {
    const open = app.slice(app.indexOf('async function _intezoOpen('), app.indexOf('function _intezoUp()'))
    expect(open).toContain('&deep=0&content=0')
    expect(open).toContain('&fresh=1')
    expect(open).toContain('_intezoCacheClear()')
  })
  it('a fa-ag csak a SAJAT mappajanak listajat kapja (nincs vegtelen rekurzio)', () => {
    // Kattintas kozben _intezoPath mar az uj mappa, a lista meg a regi: a regi
    // gyoker mappai a Csalad ala kerultek, koztuk maga a Csalad -> a fa rajzolasa
    // "Maximum call stack size exceeded"-del elhasalt.
    const sync = app.slice(app.indexOf('async function _intezoTreeSync('), app.indexOf('function _intezoTreeRender('))
    expect(sync).toContain('_intezoTreeKids.set(at, L.folders)')
    expect(sync).not.toContain('_intezoTreeKids.set(_intezoPath, L.folders)')
    const render = app.slice(app.indexOf('function _intezoTreeRender('), app.indexOf('function _intezoTreeRender(') + 4000)
    expect(render).toContain('_intezoTreeIsChild(rel, k)')
  })
})
