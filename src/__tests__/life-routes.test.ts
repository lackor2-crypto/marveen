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

// #376: az Athelyezes bekotott mappan a MOGOTTE LEVO valodi tarolot vitte el
// (a resolveLifePath a bekotes celjara fordit), es a bekotes a semmibe
// mutatott tovabb. Az Atnevezes es a Kuka mar orizte ezt -- az Athelyezes nem.
describe('POST /api/life/move -- bekotest nem szakit el', () => {
  const setup = async () => {
    mkdirSync(join(depot, 'MvTarolo', 'belso'), { recursive: true })
    writeFileSync(join(depot, 'MvTarolo', 'belso', 'irat.txt'), 'x')
    mkdirSync(join(depot, 'MvFa'), { recursive: true })
    mkdirSync(join(depot, 'MvMasik'), { recursive: true })
    const add = ctxFor('/api/life/mounts', 'POST', { rel: 'MvFa/Kotes', target: 'MvTarolo' })
    await tryHandleLife(add.ctx)
    expect(add.out.body.ok).toBe(true)
  }

  it('a bekotott mappat nem mozgatja, a valodi tarolo a helyen marad', async () => {
    await setup()
    const { ctx, out } = ctxFor('/api/life/move', 'POST', { from: 'MvFa/Kotes', to: 'MvMasik' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('mounted')
    expect(existsSync(join(depot, 'MvTarolo', 'belso', 'irat.txt'))).toBe(true)
    expect(existsSync(join(depot, 'MvMasik', 'MvTarolo'))).toBe(false)
  })

  it('bekotest tartalmazo mappat sem mozgat', async () => {
    const { ctx, out } = ctxFor('/api/life/move', 'POST', { from: 'MvFa', to: 'MvMasik' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('has_mounts')
    expect(existsSync(join(depot, 'MvFa'))).toBe(true)
  })

  it('bekotes celjat sem mozgatja el', async () => {
    const { ctx, out } = ctxFor('/api/life/move', 'POST', { from: 'MvTarolo', to: 'MvMasik' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('is_target')
    expect(existsSync(join(depot, 'MvTarolo'))).toBe(true)
  })

  it('angol feluleten angol mondatot ad', async () => {
    const { ctx, out } = ctxFor('/api/life/move?lang=en', 'POST', { from: 'MvFa/Kotes', to: 'MvMasik' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.body.message).toMatch(/linked|link/i)
  })
})

// #383: Masolas + Beillesztes. Az eredeti marad, felulirni SOHA nem szabad, es
// ugyanazok az orok allnak, mint az Athelyezesnel (git-repo, bekotes).
describe('POST /api/life/copy -- masol, sosem ir felul', () => {
  const copy = async (from: string, to: string, q = '') => {
    const { ctx, out } = ctxFor('/api/life/copy' + q, 'POST', { from, to })
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }

  it('fajlt masol, az eredeti a helyen marad', async () => {
    mkdirSync(join(depot, 'CpA'), { recursive: true })
    mkdirSync(join(depot, 'CpB'), { recursive: true })
    writeFileSync(join(depot, 'CpA', 'irat.pdf'), 'eredeti')
    const out = await copy('CpA/irat.pdf', 'CpB')
    expect(out.status).toBe(200)
    expect(out.body.rel).toBe('CpB/irat.pdf')
    expect(readFileSync(join(depot, 'CpB', 'irat.pdf'), 'utf-8')).toBe('eredeti')
    expect(existsSync(join(depot, 'CpA', 'irat.pdf'))).toBe(true)
  })

  // #383 (Boss TG 6343: "szo nelkul beillesztette ... nem szol"): foglalt nevnel
  // KERDES jon vissza (409 name_exists + javasolt nev), semmi nem jon letre;
  // a `nev (2)` csak kifejezett keepBoth-ra.
  it('foglalt nevnel 409 name_exists + javasolt nev, es semmi nem jon letre', async () => {
    writeFileSync(join(depot, 'CpB', 'irat.pdf'), 'mar itt volt')
    const out = await copy('CpA/irat.pdf', 'CpB')
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('name_exists')
    expect(out.body.suggested).toBe('irat (2).pdf')
    expect(out.body.conflictName).toBe('irat.pdf')
    expect(out.body.conflictIsDir).toBe(false)
    expect(out.body.message).toContain('irat.pdf')
    expect(existsSync(join(depot, 'CpB', 'irat (2).pdf'))).toBe(false)
    expect(readFileSync(join(depot, 'CpB', 'irat.pdf'), 'utf-8')).toBe('mar itt volt')
    const en = await copy('CpA/irat.pdf', 'CpB', '?lang=en')
    expect(en.body.message).toMatch(/already has a file/)
  })

  it('keepBoth-ra "nev (2)" lesz, a meglevo fajl erintetlen', async () => {
    const { ctx, out } = ctxFor('/api/life/copy', 'POST', { from: 'CpA/irat.pdf', to: 'CpB', keepBoth: true })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.rel).toBe('CpB/irat (2).pdf')
    expect(readFileSync(join(depot, 'CpB', 'irat.pdf'), 'utf-8')).toBe('mar itt volt')
  })

  it('ugyanabba a mappaba beillesztve is kerdez (mappanal is), keepBoth-ra masolat lesz', async () => {
    const same = await copy('CpA/irat.pdf', 'CpA')
    expect(same.status).toBe(409)
    expect(same.body.suggested).toBe('irat (2).pdf')
    mkdirSync(join(depot, 'CpA', 'Beerkezo'), { recursive: true })
    const dir = await copy('CpA/Beerkezo', 'CpA')
    expect(dir.status).toBe(409)
    expect(dir.body.conflictIsDir).toBe(true)
    expect(dir.body.suggested).toBe('Beerkezo (2)')
    expect(existsSync(join(depot, 'CpA', 'Beerkezo (2)'))).toBe(false)
    const { ctx, out } = ctxFor('/api/life/copy', 'POST', { from: 'CpA/Beerkezo', to: 'CpA', keepBoth: true })
    await tryHandleLife(ctx)
    expect(out.body.rel).toBe('CpA/Beerkezo (2)')
    expect(readFileSync(join(depot, 'CpA', 'irat.pdf'), 'utf-8')).toBe('eredeti')
  })

  it('mappat a teljes tartalmaval masol', async () => {
    mkdirSync(join(depot, 'CpDir', 'al'), { recursive: true })
    writeFileSync(join(depot, 'CpDir', 'al', 'x.txt'), 'x')
    const out = await copy('CpDir', 'CpB')
    expect(out.status).toBe(200)
    expect(readFileSync(join(depot, 'CpB', 'CpDir', 'al', 'x.txt'), 'utf-8')).toBe('x')
    expect(existsSync(join(depot, 'CpDir', 'al', 'x.txt'))).toBe(true)
  })

  it('mappat onmagaba nem masol', async () => {
    const out = await copy('CpDir', 'CpDir/al')
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('into_self')
    expect(existsSync(join(depot, 'CpDir', 'al', 'CpDir'))).toBe(false)
  })

  it('git-repoba -- a gyokerebe sem -- nem masol', async () => {
    mkdirSync(join(depot, 'CpRepo', '.git'), { recursive: true })
    mkdirSync(join(depot, 'CpRepo', 'src'), { recursive: true })
    for (const to of ['CpRepo', 'CpRepo/src']) {
      const out = await copy('CpA/irat.pdf', to)
      expect(out.status).toBe(400)
      expect(out.body.code).toBe('git_repo')
    }
    expect(existsSync(join(depot, 'CpRepo', 'irat.pdf'))).toBe(false)
  })

  it('git-repot nem sokszoroz', async () => {
    const out = await copy('CpRepo', 'CpB')
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('has_repos')
    expect(existsSync(join(depot, 'CpB', 'CpRepo'))).toBe(false)
  })

  it('bekotest nem masol, es bekotest tartalmazo mappat sem', async () => {
    mkdirSync(join(depot, 'CpTarolo'), { recursive: true })
    writeFileSync(join(depot, 'CpTarolo', 'f.txt'), 'f')
    mkdirSync(join(depot, 'CpFa'), { recursive: true })
    const add = ctxFor('/api/life/mounts', 'POST', { rel: 'CpFa/Kotes', target: 'CpTarolo' })
    await tryHandleLife(add.ctx)
    expect(add.out.body.ok).toBe(true)
    const a = await copy('CpFa/Kotes', 'CpB')
    expect(a.body.code).toBe('mounted')
    const b = await copy('CpFa', 'CpB')
    expect(b.body.code).toBe('has_mounts')
    // A bekotes CELJA viszont masolhato: onnan semmi nem mozdul.
    const c = await copy('CpTarolo', 'CpB')
    expect(c.status).toBe(200)
    expect(existsSync(join(depot, 'CpTarolo', 'f.txt'))).toBe(true)
  })

  it('angol feluleten angol mondatot ad', async () => {
    const out = await copy('CpA/irat.pdf', 'CpRepo', '?lang=en')
    expect(out.body.message).toMatch(/git repository/)
  })
})

// #383: a Kivagas + Beillesztes (move) ugyanugy kerdez foglalt nevnel.
describe('POST /api/life/move -- foglalt nevnel kerdez, felul nem ir', () => {
  const move = async (body: Record<string, unknown>) => {
    const { ctx, out } = ctxFor('/api/life/move', 'POST', body)
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }
  it('409 name_exists, semmi nem mozdul', async () => {
    mkdirSync(join(depot, 'MnA'), { recursive: true })
    mkdirSync(join(depot, 'MnB'), { recursive: true })
    writeFileSync(join(depot, 'MnA', 'level.txt'), 'uj')
    writeFileSync(join(depot, 'MnB', 'level.txt'), 'regi')
    const out = await move({ from: 'MnA/level.txt', to: 'MnB' })
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('name_exists')
    expect(out.body.suggested).toBe('level (2).txt')
    expect(readFileSync(join(depot, 'MnA', 'level.txt'), 'utf-8')).toBe('uj')
    expect(readFileSync(join(depot, 'MnB', 'level.txt'), 'utf-8')).toBe('regi')
  })
  it('keepBoth-ra "nev (2)" neven kerul at, a meglevo erintetlen', async () => {
    const out = await move({ from: 'MnA/level.txt', to: 'MnB', keepBoth: true })
    expect(out.status).toBe(200)
    expect(out.body.rel).toBe('MnB/level (2).txt')
    expect(existsSync(join(depot, 'MnA', 'level.txt'))).toBe(false)
    expect(readFileSync(join(depot, 'MnB', 'level (2).txt'), 'utf-8')).toBe('uj')
    expect(readFileSync(join(depot, 'MnB', 'level.txt'), 'utf-8')).toBe('regi')
  })
  it('mappanal is kerdez', async () => {
    mkdirSync(join(depot, 'MnA', 'Beerkezo'), { recursive: true })
    mkdirSync(join(depot, 'MnB', 'Beerkezo'), { recursive: true })
    const out = await move({ from: 'MnA/Beerkezo', to: 'MnB' })
    expect(out.status).toBe(409)
    expect(out.body.conflictIsDir).toBe(true)
    expect(existsSync(join(depot, 'MnA', 'Beerkezo'))).toBe(true)
  })
})

// #383 2. lepes (Boss TG 6346: "minden kell ami a Windows intezojeben is
// van"): Csere / Kihagyas / Mindketto megtartasa, mappanal Egyesites. Felulirni
// soha nem ir: a lecserelt elem a Kukaba kerul, onnan visszaallithato.
describe('beillesztes utkozessel -- Csere / Kihagyas / Egyesites', () => {
  const post = async (url: string, body: Record<string, unknown>) => {
    const { ctx, out } = ctxFor(url, 'POST', body)
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }
  // A Kuka a fa gyokerbeli `Kuka/<idobelyeg>/` mappaja (#395): minden ott levo fajl
  // tartalmat kigyujtjuk, hogy lassuk, a regi tenyleg odakerult.
  const trashContents = (): string[] => {
    const acc: string[] = []
    const walk = (d: string) => {
      if (!existsSync(d)) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else acc.push(readFileSync(p, 'utf-8'))
      }
    }
    walk(join(depot, 'Kuka'))
    return acc
  }
  const mk = (rel: string, content?: string) => {
    if (content === undefined) mkdirSync(join(depot, rel), { recursive: true })
    else { mkdirSync(join(depot, rel, '..'), { recursive: true }); writeFileSync(join(depot, rel), content) }
  }
  const read = (rel: string) => readFileSync(join(depot, rel), 'utf-8')

  it('a 409 megmondja, mit lehet: fajlnal Csere igen, Egyesites nem', async () => {
    mk('RsA/a.txt', 'uj-a'); mk('RsB/a.txt', 'regi-a')
    const out = await post('/api/life/copy', { from: 'RsA/a.txt', to: 'RsB' })
    expect(out.status).toBe(409)
    expect(out.body.canReplace).toBe(true)
    expect(out.body.canMerge).toBe(false)
  })

  it('Csere (masolas): az uj a helyen, a regi a Kukaban, az eredeti megmarad', async () => {
    const out = await post('/api/life/copy', { from: 'RsA/a.txt', to: 'RsB', resolution: 'replace' })
    expect(out.status).toBe(200)
    expect(out.body.replaced).toBe(1)
    expect(read('RsB/a.txt')).toBe('uj-a')
    expect(read('RsA/a.txt')).toBe('uj-a')
    expect(trashContents()).toContain('regi-a')
    expect(existsSync(join(depot, 'RsB', 'a (2).txt'))).toBe(false)
  })

  it('Csere (kivagas): a forras eltunik, a regi a Kukaban', async () => {
    mk('RsA/b.txt', 'uj-b'); mk('RsB/b.txt', 'regi-b')
    const out = await post('/api/life/move', { from: 'RsA/b.txt', to: 'RsB', resolution: 'replace' })
    expect(out.status).toBe(200)
    expect(read('RsB/b.txt')).toBe('uj-b')
    expect(existsSync(join(depot, 'RsA', 'b.txt'))).toBe(false)
    expect(trashContents()).toContain('regi-b')
  })

  it('Kihagyas: semmi nem valtozik, a forras is marad', async () => {
    mk('RsA/c.txt', 'uj-c'); mk('RsB/c.txt', 'regi-c')
    const out = await post('/api/life/move', { from: 'RsA/c.txt', to: 'RsB', resolution: 'skip' })
    expect(out.status).toBe(200)
    expect(out.body.code).toBe('skipped')
    expect(read('RsA/c.txt')).toBe('uj-c')
    expect(read('RsB/c.txt')).toBe('regi-c')
  })

  it('Csere nem megy ugyanabba a mappaba (onmagat nem csereli le), sem mappara', async () => {
    const self = await post('/api/life/copy', { from: 'RsA/c.txt', to: 'RsA' })
    expect(self.status).toBe(409)
    expect(self.body.canReplace).toBe(false)
    const r = await post('/api/life/copy', { from: 'RsA/c.txt', to: 'RsA', resolution: 'replace' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('cannot_replace')
    expect(read('RsA/c.txt')).toBe('uj-c')
    mk('RsD/Mappa'); mk('RsE/Mappa')
    const d = await post('/api/life/copy', { from: 'RsD/Mappa', to: 'RsE', resolution: 'replace' })
    expect(d.body.code).toBe('cannot_replace')
    const en = await post('/api/life/copy?lang=en', { from: 'RsD/Mappa', to: 'RsE', resolution: 'replace' })
    expect(en.body.message).toMatch(/Only a file can replace a file/)
  })

  it('mappa-utkozes: a 409 felsorolja a belso utkozeseket', async () => {
    mk('MgA/Fotok/1.jpg', 'uj-1'); mk('MgA/Fotok/2.jpg', 'uj-2'); mk('MgA/Fotok/3.jpg', 'uj-3')
    mk('MgA/Fotok/al/x.txt', 'uj-x'); mk('MgA/Fotok/csak-itt.txt', 'itt')
    mk('MgB/Fotok/1.jpg', 'regi-1'); mk('MgB/Fotok/2.jpg', 'regi-2'); mk('MgB/Fotok/3.jpg', 'regi-3')
    mk('MgB/Fotok/al/x.txt', 'regi-x'); mk('MgB/Fotok/csak-ott.txt', 'ott')
    const out = await post('/api/life/copy', { from: 'MgA/Fotok', to: 'MgB' })
    expect(out.status).toBe(409)
    expect(out.body.canMerge).toBe(true)
    expect(out.body.canReplace).toBe(false)
    const paths = out.body.innerConflicts.map((c: any) => c.path).sort()
    expect(paths).toEqual(['1.jpg', '2.jpg', '3.jpg', 'al/x.txt'])
    expect(out.body.innerTotal).toBe(4)
  })

  it('Egyesites (masolas) fajlonkent: csere / kihagyas / mindketto, a tobbi alapbol mindketto', async () => {
    const out = await post('/api/life/copy', {
      from: 'MgA/Fotok', to: 'MgB', resolution: 'merge',
      perFile: { '1.jpg': 'replace', '2.jpg': 'skip', 'al/x.txt': 'replace' },
    })
    expect(out.status).toBe(200)
    expect(out.body.replaced).toBe(2)
    expect(out.body.skipped).toBe(1)
    expect(out.body.keptBoth).toBe(1)
    expect(read('MgB/Fotok/1.jpg')).toBe('uj-1')
    expect(read('MgB/Fotok/2.jpg')).toBe('regi-2')
    expect(read('MgB/Fotok/3.jpg')).toBe('regi-3')
    expect(read('MgB/Fotok/3 (2).jpg')).toBe('uj-3')
    expect(read('MgB/Fotok/al/x.txt')).toBe('uj-x')
    expect(read('MgB/Fotok/csak-itt.txt')).toBe('itt')
    expect(read('MgB/Fotok/csak-ott.txt')).toBe('ott')
    expect(trashContents()).toEqual(expect.arrayContaining(['regi-1', 'regi-x']))
    // masolas: a forras erintetlen
    expect(read('MgA/Fotok/1.jpg')).toBe('uj-1')
    expect(out.body.message).toMatch(/Kukában/)
  })

  it('Egyesites (kivagas) "mindre ezt" Cserevel: a kiurult forras-mappa eltunik', async () => {
    mk('MmA/Docs/a.txt', 'uj-a'); mk('MmA/Docs/sub/b.txt', 'uj-b'); mk('MmA/Docs/uj.txt', 'uj')
    mk('MmB/Docs/a.txt', 'regi-a'); mk('MmB/Docs/sub/b.txt', 'regi-b')
    const out = await post('/api/life/move', { from: 'MmA/Docs', to: 'MmB', resolution: 'merge', fileResolution: 'replace' })
    expect(out.status).toBe(200)
    expect(out.body.replaced).toBe(2)
    expect(read('MmB/Docs/a.txt')).toBe('uj-a')
    expect(read('MmB/Docs/sub/b.txt')).toBe('uj-b')
    expect(read('MmB/Docs/uj.txt')).toBe('uj')
    expect(existsSync(join(depot, 'MmA', 'Docs'))).toBe(false)
    expect(trashContents()).toEqual(expect.arrayContaining(['regi-a', 'regi-b']))
  })

  it('Egyesites (kivagas) Kihagyassal: a kihagyott fajl a forrasban marad', async () => {
    mk('MsA/D/k.txt', 'uj-k'); mk('MsA/D/m.txt', 'uj-m')
    mk('MsB/D/k.txt', 'regi-k')
    const out = await post('/api/life/move', { from: 'MsA/D', to: 'MsB', resolution: 'merge', fileResolution: 'skip' })
    expect(out.status).toBe(200)
    expect(read('MsB/D/k.txt')).toBe('regi-k')
    expect(read('MsB/D/m.txt')).toBe('uj-m')
    expect(read('MsA/D/k.txt')).toBe('uj-k')
  })

  it('ismeretlen feloldast nem hajt vegre: a sima kerdes jon vissza', async () => {
    mk('MxA/q.txt', 'uj'); mk('MxB/q.txt', 'regi')
    const out = await post('/api/life/copy', { from: 'MxA/q.txt', to: 'MxB', resolution: 'overwrite' })
    expect(out.status).toBe(409)
    expect(read('MxB/q.txt')).toBe('regi')
  })

  it('Egyesites git-repot tartalmazo cel-mappaba nem megy', async () => {
    mk('MrA/Kod/f.txt', 'f'); mk('MrB/Kod/proj/.git'); mk('MrB/Kod/proj/src')
    const out = await post('/api/life/copy', { from: 'MrA/Kod', to: 'MrB', resolution: 'merge' })
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('has_repos')
    expect(existsSync(join(depot, 'MrB', 'Kod', 'f.txt'))).toBe(false)
  })
})

// #383 hiba (Boss TG 6350: "megprobaltam torolni a beerkezo 2 nevu mappat, es
// nem engedte"): a gyokerben CSAK az a mappa vedett, amit a Konyvtarszerkezet
// letrehozasa ujra letrehozna -- egy beillesztett masolat torolheto.
describe('POST /api/life/trash -- gyokerben csak a sablon-ag vedett', () => {
  const trash = async (rel: string, q = '') => {
    const { ctx, out } = ctxFor('/api/life/trash' + q, 'POST', { rel })
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }
  it('egy beillesztett gyoker-mappa (Beerkezo (2)) torolheto', async () => {
    mkdirSync(join(depot, 'Beerkezo (2)'), { recursive: true })
    writeFileSync(join(depot, 'Beerkezo (2)', 'f.txt'), 'f')
    const out = await trash('Beerkezo (2)')
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(existsSync(join(depot, 'Beerkezo (2)'))).toBe(false)
  })
  it('a sablon fo-aga (a Konyvtarszerkezet letrehozasa ujra letrehozna) tovabbra sem', async () => {
    // Ugyanabbol a forrasbol, amibol a Konyvtarszerkezet letrehozasa epit
    // (a telepites nyelven), nem kezzel irt nevlistabol.
    const { planLifeTree, loadLifeConfig } = await import('../life-tree.js')
    const { APP_LANG } = await import('../config.js')
    const top = planLifeTree(loadLifeConfig(), APP_LANG)[0].rel.split('/')[0]
    mkdirSync(join(depot, top), { recursive: true })
    const out = await trash(top)
    // A Kuka-vegpont a visszautasitast is 200-zal adja, `ok: false`-szal.
    expect(out.body.ok).toBe(false)
    expect(out.body.code).toBe('top')
    expect(existsSync(join(depot, top))).toBe(true)
    const en = await trash(top, '?lang=en')
    expect(en.body.code).toBe('top')
    expect(en.body.message).not.toMatch(/[áéőű]/)
  })
})

describe('POST /api/life/move -- git-repo gyokerebe sem', () => {
  it('a repo gyokerebe nem helyez at', async () => {
    mkdirSync(join(depot, 'MvRepo', '.git'), { recursive: true })
    mkdirSync(join(depot, 'MvSrc'), { recursive: true })
    writeFileSync(join(depot, 'MvSrc', 'a.txt'), 'a')
    const { ctx, out } = ctxFor('/api/life/move', 'POST', { from: 'MvSrc/a.txt', to: 'MvRepo' })
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.code).toBe('git_repo')
    expect(existsSync(join(depot, 'MvSrc', 'a.txt'))).toBe(true)
  })
})

describe('GET /api/life/media-targets -- "Athelyezes szemelyhez" celjai (#381)', () => {
  beforeEach(() => {
    rmSync(join(store, 'life-tree.json'), { force: true })
    for (const n of readdirSync(depot)) rmSync(join(depot, n), { recursive: true, force: true })
  })

  const get = async () => {
    const { ctx, out } = ctxFor('/api/life/media-targets', 'GET')
    expect(await tryHandleLife(ctx)).toBe(true)
    return out
  }

  it('friss telepitesen (nincs fa-beallitas) ures lista, nem hiba', async () => {
    const out = await get()
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(Array.isArray(out.body.targets)).toBe(true)
  })

  it('a szemely Media/Fotok utja a fa tervebol jon, es megmondja, letezik-e mar', async () => {
    const { ctx, out: saved } = ctxFor('/api/life/config', 'POST', { persons: [owner], companies: [{ name: 'Teszt Kft' }] })
    await tryHandleLife(ctx)
    expect(saved.status).toBe(200)
    const out = await get()
    const p = out.body.targets.find((x: any) => x.name === 'Teszt Elek')
    expect(p).toBeTruthy()
    expect(p.kind).toBe('person')
    expect(p.media.photos).toMatch(/Teszt Elek\//)
    expect(p.exists.photos).toBe(false)
    mkdirSync(join(depot, p.media.photos), { recursive: true })
    const again = (await get()).body.targets.find((x: any) => x.name === 'Teszt Elek')
    expect(again.exists.photos).toBe(true)
  })
})
