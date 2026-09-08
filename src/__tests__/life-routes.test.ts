// AZ ELETFA VEGPONTJAI -- a keres TORZSENEK olvasasa.
//
// Ez a fajl egy valos hiba miatt keszult (2026-08-21): a `readBody()` BUFFERT
// ad vissza, nem elemzett JSON-t, es a life-vegpontok ugy hasznaltak, mintha
// objektum lenne. Igy MIND A HAT POST-vegpont csendben ugy viselkedett, mintha
// ures keres erkezett volna -- a felhasznalo kitoltotte az urlapot, es egy
// teljesen felrevezeto valaszt kapott ("Legalabb egy szemelynek szerepelnie
// kell a faban"), noha eppen ket szemelyt kuldott be.
//
// A unit-tesztek ezt NEM fogtak meg, mert azok a modulokat kozvetlenul hivjak,
// a HTTP-reteget kihagyva. Ezert megy ez a teszt a VALODI utvonalkezelon at.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lroutes-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-lrstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: store }
})

const { tryHandleLife } = await import('../web/routes/life.js')

/**
 * Egy keres, ahogy a szerver latja.
 *
 * A `req` VALODI olvashato folyam, nem egy elore elemzett objektum -- pont ez
 * a lenyeg: ha a kezelo elfelejtene elemezni a torzset, ennek a tesztnek el
 * kell buknia.
 */
function ctxFor(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

const owner = { name: 'Teszt Elek', role: 'owner' as const, countries: [], mediaGroups: [] }

describe('POST /api/life/config -- a torzs tenyleg megerkezik', () => {
  beforeEach(() => { rmSync(join(store, 'life-tree.json'), { force: true }) })

  it('elmenti a bekuldott szemelyeket', async () => {
    const { ctx, out } = ctxFor('/api/life/config', 'POST', { persons: [owner], companies: [{ name: 'Teszt Kft' }] })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.config.persons[0].name).toBe('Teszt Elek')
    expect(out.body.config.companies[0].name).toBe('Teszt Kft')
    // Az elonezet ugyanabban a valaszban jon: a felhasznalo MEG a lemezre
    // iras elott lassa, mi fog letrejonni.
    expect(out.body.status.missing.length).toBeGreaterThan(0)
  })

  it('ket gazdanal A GAZDA-uzenetet adja, nem azt hogy nincs szemely', async () => {
    // Ez a konkret hiba, ami miatt a fajl keszult: a felrevezeto uzenet
    // rosszabb, mint a hianyzo -- a felhasznalo a rossz dolgot javitotta volna.
    const { ctx, out } = ctxFor('/api/life/config', 'POST', {
      persons: [{ ...owner, name: 'A' }, { ...owner, name: 'B' }], companies: [],
    })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.message).toContain('gazda')
  })

  it('a hibauzenet EMBERI MONDAT, nem gepi kod', async () => {
    const { ctx, out } = ctxFor('/api/life/config', 'POST', { persons: [], companies: [] })
    expect(out.status).toBe(0)
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(typeof out.body.message).toBe('string')
    expect(out.body.message.length).toBeGreaterThan(15)
  })

  it('romlott JSON-tol nem szall el, emberi valaszt ad', async () => {
    const { ctx, out } = ctxFor('/api/life/config', 'POST', '{ez nem json')
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.message).toBeTruthy()
  })
})

describe('a tobbi POST-vegpont is elemzi a torzset', () => {
  it('mkdir a bekuldott nevet hasznalja', async () => {
    const { ctx, out } = ctxFor('/api/life/mkdir', 'POST', { parent: '', name: 'probamappa' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.rel).toBe('probamappa')
  })

  it('a bekotes a bekuldott celt latja (nem ures kerest)', async () => {
    // Nem letezo cel: a valasz `missing` legyen -- ha a torzs nem erkezne meg,
    // ures nevre panaszkodna helyette.
    const { ctx, out } = ctxFor('/api/life/mounts', 'POST', { rel: 'probamappa', target: 'fotok/nincs-ilyen' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.body.code).toBe('missing')
  })

  it('a papir-rogzites a bekuldott utvonalat hasznalja', async () => {
    const { ctx, out } = ctxFor('/api/life/physical', 'POST', {
      path: 'probamappa', physical: true, location: 'probamappa', note: 'iratrendezo',
    })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.physical).toBe(true)
    expect(out.body.note).toBe('iratrendezo')
  })
})

// BEERKEZO AI-JAVASLAT (kartya #204): az analyze CSAK ajanl, a place mindig a
// meglevo biztonsagi szabalyokon (soha nem ir felul, hitelesito adatot
// kiszur) at mozgat -- ugyanugy, mint a lanc-alapu Besorolás.
describe('POST /api/life/inbox/analyze es /api/life/inbox/place', () => {
  const inbox = join(depot, 'Beérkező')

  beforeEach(() => {
    rmSync(join(store, 'life-tree.json'), { force: true })
    rmSync(inbox, { recursive: true, force: true })
    mkdirSync(inbox, { recursive: true })
  })

  it('ures BEERKEZO-re nyugodt "nincs mit elemezni"-t mond, nem hibat', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/analyze', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.reason).toBe('empty')
    expect(out.body.suggestions).toEqual([])
  })

  it('hetkoznapi iratra ad javaslatot, bizonytalansaggal (friss telepitesen nincs ismert arc)', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/analyze', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.suggestions.length).toBe(1)
    const sug = out.body.suggestions[0]
    expect(sug.name).toBe('szamla.pdf')
    expect(sug.credentialWarning).toBe('')
    // Nincs ismert mappa meg tanult index -- a gazdat nem talaljuk ki.
    expect(sug.needsReview).toBe(true)
    expect(typeof out.body.ocrAvailable).toBe('boolean')
    expect(typeof out.body.faceRecognitionAvailable).toBe('boolean')
  })

  it('hitelesito adatra a javaslat is csak a Vault-uzenetet adja, celt nem', async () => {
    writeFileSync(join(inbox, 'jelszavak.txt'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/analyze', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    const sug = out.body.suggestions.find((s: any) => s.name === 'jelszavak.txt')
    expect(sug.credentialWarning).toContain('Vault')
    expect(sug.targetRel).toBe('')
    expect(sug.owner.personId).toBe('')
  })

  it('place: tetel nelkul emberi hibat ad, nem nyul a lemezhez', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/place', 'POST', { targetRel: 'X/Y' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('no_item')
  })

  it('place: cel nelkul NEM talalja ki a gazdat (23. pont, 1. szabaly)', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/place', 'POST', { name: 'szamla.pdf' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('no_target')
  })

  it('place: a megadott celra tenyleg athelyezi, es a javasolt nevre atnevezi', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    mkdirSync(join(depot, 'Teszt Elek', 'Pénzügy'), { recursive: true })
    const { ctx, out } = ctxFor('/api/life/inbox/place', 'POST', {
      name: 'szamla.pdf', targetRel: 'Teszt Elek/Pénzügy', newName: 'teszt-elek_2026-01_szamla',
    })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.rel).toBe('Teszt Elek/Pénzügy/teszt-elek_2026-01_szamla.pdf')
    expect(existsSync(join(depot, 'Teszt Elek', 'Pénzügy', 'teszt-elek_2026-01_szamla.pdf'))).toBe(true)
    expect(existsSync(join(inbox, 'szamla.pdf'))).toBe(false)
  })

  it('place: mar letezo nevre NEM ir felul (23. pont, 2. szabaly)', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'uj')
    const celDir = join(depot, 'Teszt Elek', 'Pénzügy')
    mkdirSync(celDir, { recursive: true })
    writeFileSync(join(celDir, 'szamla.pdf'), 'regi')
    const { ctx, out } = ctxFor('/api/life/inbox/place', 'POST', { name: 'szamla.pdf', targetRel: 'Teszt Elek/Pénzügy' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.body.ok).toBe(false)
    expect(readFileSync(join(celDir, 'szamla.pdf'), 'utf8')).toBe('regi')
    expect(existsSync(join(inbox, 'szamla.pdf'))).toBe(true)
  })
})
