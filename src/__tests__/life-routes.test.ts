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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
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

// A valodi OCR/arcfelismero venv (dlib) telepitve lehet EZEN a gepen, de a
// route-teszt NEM akar tole fuggeni -- ezert a `enrollFace` fuggvenyt itt
// determinisztikusan mockoljuk, a szemely-azonosito alapjan dontve.
vi.mock('../life-vision-adapter.js', () => ({
  enrollFace: vi.fn((absPath: string, personId: string, lang: string = 'hu') => {
    if (absPath.includes('homalyos')) {
      return { ok: false, message: lang === 'en' ? 'no face found' : 'nem talalhato arc' }
    }
    return { ok: true, savedPath: `/fake-gallery/${personId}/fake.jpg`, message: lang === 'en' ? 'saved' : 'elmentve' }
  }),
}))

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

  // Kartya #327: a kijeloles NEM hagyhato figyelmen kivul. A `names` szurt
  // elemzes pontosan a kijelolt tetelt adja vissza, es ha a kijelolesben nincs
  // elemezheto fajl (csak mappa), azt mondja ki, NEM azt, hogy "ures".
  it('kijeloles: names-szel CSAK a kijelolt tetelt elemzi', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    writeFileSync(join(inbox, 'level.txt'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/analyze', 'POST', { names: ['level.txt'] })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.suggestions.map((s: any) => s.name)).toEqual(['level.txt'])
  })

  it('kijeloles: csak mappa kijelolve -> selection-empty, nem "a BEERKEZO ures"', async () => {
    writeFileSync(join(inbox, 'szamla.pdf'), 'x')
    mkdirSync(join(inbox, 'Almappa'))
    const { ctx, out } = ctxFor('/api/life/inbox/analyze?lang=hu', 'POST', { names: ['Almappa'] })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.reason).toBe('selection-empty')
    expect(out.body.suggestions).toEqual([])
    expect(out.body.message).not.toContain('üres')
    expect(out.body.message).toContain('kijelölt')
    const en = ctxFor('/api/life/inbox/analyze?lang=en', 'POST', { names: ['Almappa'] })
    await tryHandleLife(en.ctx)
    expect(en.out.body.message).toContain('selected')
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

describe('POST /api/life/inbox/enroll-face', () => {
  const inbox = join(depot, 'Beérkező')
  let personId = ''

  beforeEach(async () => {
    rmSync(join(store, 'life-tree.json'), { force: true })
    rmSync(inbox, { recursive: true, force: true })
    mkdirSync(inbox, { recursive: true })
    const { ctx, out } = ctxFor('/api/life/config', 'POST', { persons: [owner], companies: [] })
    await tryHandleLife(ctx)
    personId = out.body.config.persons[0].id
  })

  it('tetel nelkul emberi hibat ad', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { personId })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('no_item')
  })

  it('szemely nelkul emberi hibat ad', async () => {
    writeFileSync(join(inbox, 'apu.jpg'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { name: 'apu.jpg' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('no_person')
  })

  it('ismeretlen szemely-azonositora emberi hibat ad', async () => {
    writeFileSync(join(inbox, 'apu.jpg'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { name: 'apu.jpg', personId: 'nincs-ilyen' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('unknown_person')
  })

  it('mar nem letezo BEERKEZO-tetelre emberi hibat ad', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { name: 'nincs-ilyen.jpg', personId })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('not_found')
  })

  it('sikeres eseten az enrollFace eredmenyet adja vissza valtozatlanul', async () => {
    writeFileSync(join(inbox, 'apu.jpg'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { name: 'apu.jpg', personId })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.savedPath).toBe(`/fake-gallery/${personId}/fake.jpg`)
  })

  it('sikertelen arcfelismeresnel 400-at ad az enrollFace uzenetevel', async () => {
    writeFileSync(join(inbox, 'homalyos.jpg'), 'x')
    const { ctx, out } = ctxFor('/api/life/inbox/enroll-face', 'POST', { name: 'homalyos.jpg', personId })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.ok).toBe(false)
    expect(out.body.message).toContain('arc')
  })
})

// CELMAPPA LETREHOZASA A HELYSZINEN (kartya #246): a "hova kerulne" javaslat
// gyakran meg nem letezo mappara mutat -- ez a vegpont a VALODI utvonalkezelon
// keresztul hozza letre, EGY kattintasra, a Beerkezobol kilepes nelkul.
describe('POST /api/life/inbox/create-target-folder', () => {
  const PERSON = 'Teszt Elek'

  beforeEach(() => {
    rmSync(join(store, 'life-tree.json'), { force: true })
    rmSync(join(depot, PERSON), { recursive: true, force: true })
  })

  it('ures rel-re emberi hibat ad, nem nyul a lemezhez', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/create-target-folder', 'POST', { rel: '' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.ok).toBe(false)
    expect(typeof out.body.message).toBe('string')
    expect(out.body.message.length).toBeGreaterThan(5)
  })

  it('letrehozza a tobbszintes, meg nem letezo celutvonalat egy hivasban', async () => {
    const rel = `${PERSON}/Hatóságok/Németország/Jobcenter`
    const { ctx, out } = ctxFor('/api/life/inbox/create-target-folder', 'POST', { rel })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(existsSync(join(depot, PERSON, 'Hatóságok', 'Németország', 'Jobcenter'))).toBe(true)
  })

  it('mar letezo celutvonalra is ok, nem hibazik (idempotens)', async () => {
    const rel = `${PERSON}/Hatóságok`
    mkdirSync(join(depot, PERSON, 'Hatóságok'), { recursive: true })
    const { ctx, out } = ctxFor('/api/life/inbox/create-target-folder', 'POST', { rel })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
  })

  it('a fabol kivezeto utvonalat elutasitja, nem hoz letre semmit', async () => {
    const { ctx, out } = ctxFor('/api/life/inbox/create-target-folder', 'POST', { rel: '../../kiszoktem' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.ok).toBe(false)
    expect(existsSync(join(depot, '..', 'kiszoktem'))).toBe(false)
  })
})

// A MOTOR UZENETE ER KI A FELULETRE -- HTTP-szinten mérve.
//
// A #337 ket defektjenek a javitasa a `src/life-tree.ts`-ben ul, de a
// felhasznalo NEM azt latja: o a route valaszat latja. Ket ok, amiert ezt itt
// is meg kell merni:
//
// (1) A route KORABBAN felulirta a motor mondatat (`{ ...result, ok: true }` +
//     sajat "mar teljes" szoveg). Egy unit-teszt a motoron zold volt, mikozben
//     a kepernyore a regi, felrevezeto mondat ment ki -- a ket veg kulon-kulon
//     tesztelve volt, a szal kozottuk nem.
// (2) A mappa NEVE a telepites nyelvet koveti (APP_LANG, mert a lemezen all),
//     az UZENET viszont a FELULET nyelvet -- ezt csak a `?lang=` lekerdezessel
//     lehet ellenorizni, tehat csak itt.
describe('POST /api/life/ensure -- a motor uzenete er ki a feluletre', () => {
  const PERSON2 = 'Proba Peter'

  async function frissFa() {
    rmSync(join(store, 'life-tree-created.json'), { force: true })
    const { ctx: c1 } = ctxFor('/api/life/config', 'POST', {
      persons: [{ name: PERSON2, role: 'owner', countries: [], mediaGroups: [] }],
      companies: [],
    })
    await tryHandleLife(c1)
    const { ctx, out } = ctxFor('/api/life/ensure', 'POST', {})
    await tryHandleLife(ctx)
    return out
  }

  it('a felhasznalo altal kitorolt ag utan NEM azt allitja, hogy mar teljes volt', async () => {
    const elso = await frissFa()
    expect(elso.status).toBe(200)
    expect(elso.body.created.length).toBeGreaterThan(0)

    // A felhasznalo kitorol egy mappat, amit MI hoztunk letre.
    rmSync(join(depot, elso.body.created[0]), { recursive: true, force: true })

    const { ctx, out } = ctxFor('/api/life/ensure', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.abandoned.length).toBeGreaterThanOrEqual(1)
    // A nulla ket dolgot jelenthet: "tenyleg teljes" vagy "N elem hianyzik,
    // mert te torolted". A toastbol ez a kulonbseg latszodjon.
    expect(out.body.message).not.toContain('már teljes')
    expect(out.body.message).toContain(String(out.body.abandoned.length))
  })

  it('ha egy mappat nem sikerul letrehozni, az `ok` HAMIS -- nem fix igaz', async () => {
    // A route korabban `{ ...result, ok: true }`-t kuldott, tehat a sikertelen
    // letrehozast is sikernek nevezte. Itt szandekosan elrontjuk egy ag utjat:
    // FAJL all ott, ahova mappa kellene, ezert a mkdir elbukik.
    rmSync(join(store, 'life-tree-created.json'), { force: true })
    const { ctx: c1 } = ctxFor('/api/life/config', 'POST', {
      persons: [{ name: PERSON2, role: 'owner', countries: [], mediaGroups: [] }],
      companies: [],
    })
    await tryHandleLife(c1)
    const { ctx: cs, out: st } = ctxFor('/api/life/status', 'GET')
    await tryHandleLife(cs)
    const felsoSzint = (st.body.missing as string[]).find((r) => !r.includes('/'))
    expect(felsoSzint).toBeTruthy()
    rmSync(join(depot, felsoSzint as string), { recursive: true, force: true })
    writeFileSync(join(depot, felsoSzint as string), 'nem mappa, hanem fajl')

    const { ctx, out } = ctxFor('/api/life/ensure', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.failed.length).toBeGreaterThan(0)
    expect(out.body.ok).toBe(false)

    rmSync(join(depot, felsoSzint as string), { force: true })
  })

  it('?lang=en mellett az uzenet ANGOL, akkor is ha a mappanevek magyarok', async () => {
    await frissFa()
    const { ctx, out } = ctxFor('/api/life/ensure?lang=en', 'POST', {})
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(typeof out.body.message).toBe('string')
    expect(out.body.message.length).toBeGreaterThan(0)
    // Nem szolistat egyeztetunk (az torekeny), hanem azt merjuk, hogy a mondat
    // nem MAGYAR: magyar ekezetes betu nincs benne.
    expect(out.body.message).not.toMatch(/[őűáéíóöúüÁÉÍÓÖŐÚÜŰ]/)
  })

  it('a kitorolt kiseroirat megjelenik az eldobottak kozt, es visszakerheto', async () => {
    await frissFa()
    const kiseroirat = readdirSync(depot).find((n) => n.endsWith('.md'))
    expect(kiseroirat).toBeTruthy()
    rmSync(join(depot, kiseroirat as string), { force: true })

    const { ctx: cs, out: st } = ctxFor('/api/life/status', 'GET')
    expect(await tryHandleLife(cs)).toBe(true)
    expect(st.body.abandoned).toContain(kiseroirat)

    // ... es az `ensure` szandekosan NEM hozza vissza magatol.
    const { ctx: ce } = ctxFor('/api/life/ensure', 'POST', {})
    await tryHandleLife(ce)
    expect(existsSync(join(depot, kiseroirat as string))).toBe(false)

    // A felhasznalo kifejezett kerese hozza vissza, tartalommal.
    const { ctx, out } = ctxFor('/api/life/restore-abandoned?lang=en', 'POST', { rels: [kiseroirat] })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.created).toContain(kiseroirat)
    expect(readFileSync(join(depot, kiseroirat as string), 'utf-8').length).toBeGreaterThan(0)
    expect(out.body.message).not.toMatch(/[őűáéíóöúüÁÉÍÓÖŐÚÜŰ]/)
  })
})

describe('POST /api/life/config -- a szemelyek kozos mappaja (Csalad)', () => {
  beforeEach(() => {
    rmSync(join(store, 'life-tree.json'), { force: true })
    for (const n of readdirSync(depot)) rmSync(join(depot, n), { recursive: true, force: true })
  })

  const post = async (body: unknown) => {
    const { ctx, out } = ctxFor('/api/life/config', 'POST', body)
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }

  it('meglevo mappaknal NEM ment csendben: elobb a lista, csak megerosites utan mozgat', async () => {
    expect((await post({ persons: [owner], companies: [] })).status).toBe(200)
    mkdirSync(join(depot, 'Teszt Elek'), { recursive: true })
    const first = await post({ persons: [owner], companies: [], personsGroup: 'Család' })
    expect(first.status).toBe(200)
    expect(first.body.needsConfirm).toBe('personsGroup')
    expect(first.body.moves).toEqual([{ from: 'Teszt Elek', to: 'Család/Teszt Elek', conflict: false }])
    expect(existsSync(join(depot, 'Teszt Elek'))).toBe(true)
    expect(JSON.parse(readFileSync(join(store, 'life-tree.json'), 'utf8')).personsGroup || '').toBe('')

    const ok = await post({ persons: [owner], companies: [], personsGroup: 'Család', confirmGroupMove: true })
    expect(ok.status).toBe(200)
    expect(ok.body.config.personsGroup).toBe('Család')
    expect(existsSync(join(depot, 'Család', 'Teszt Elek'))).toBe(true)
    expect(existsSync(join(depot, 'Teszt Elek'))).toBe(false)
  })

  it('foglalt celnal 409, emberi mondattal, es semmi nem mozdul', async () => {
    expect((await post({ persons: [owner], companies: [] })).status).toBe(200)
    mkdirSync(join(depot, 'Teszt Elek'), { recursive: true })
    mkdirSync(join(depot, 'Család', 'Teszt Elek'), { recursive: true })
    const r = await post({ persons: [owner], companies: [], personsGroup: 'Család', confirmGroupMove: true })
    expect(r.status).toBe(409)
    expect(r.body.message).toContain('Család/Teszt Elek')
    expect(existsSync(join(depot, 'Teszt Elek'))).toBe(true)
  })

  it('fix ag nevet (Archív) nem enged kozos mappanak', async () => {
    const r = await post({ persons: [owner], companies: [], personsGroup: 'Archív' })
    expect(r.status).toBe(400)
    expect(r.body.message).toContain('Archív')
  })
})
