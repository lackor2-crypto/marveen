// Fotok oldal -- Boss 2026-08-14: "a fotok alatt a google fotokat akarom
// latni. csakis azokat." (Az elozo, Drive-fajlokbol epitett valtozatot a Boss
// visszautasitotta: "Nem akarok latni drive fileket a fotokban. semmit. akkor
// sem ha azok fotok!")
//
// Amit ez a fajl vedeni hivatott, harom mert korlat kore epul:
//   1. A Library API 2025-03-31 ota nem lat mast, csak amit maga az app toltott
//      fel -> egyedul a Picker jarhato. A scope-nak benne kell lennie a
//      google-auth.py-ban, kulonben minden fiok 403-at kap.
//   2. A kivalasztott kepek `baseUrl`-je 60 PERCIG el -> a bajtokat azonnal a
//      lemezre kell hozni, es a `=w..-h..` / `=dv` meretjelolest a vegere tenni.
//   3. A dashboard `Authorization: Bearer` fejleccel hitelesit -> egy sima
//      <img src="/api/photos/media"> a 401 JSON-t kapna kep helyett.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  loadIndex,
  hasPickerScope,
  normalizeMediaItem,
  mediaBytesUrl,
  isAllowedPhotosUrl,
  safePhotoFileName,
  safeAccountDir,
  sortPhotos,
  humanBytes,
  pickerApiDisabled,
  pickerNoPhotosAccount,
  pickerSessionGone,
  dedupeIndex,
  uniqueBytes,
  sha256Bytes,
  backfillHashes,
  queuePhotoDownload,
  streamToFile,
  breathe,
  photoThrottleConfig,
  availableMemMb,
  sweepPartFiles,
  orphanFiles,
  sweepOrphanFiles,
  photoFileOwner,
  rememberPickerRun,
  getPickerRun,
  clearPickerRuns,
  fetchPickedMediaItems,
  PICKER_SCOPE,
  SAVE_WIDTH,
  thumbFileName,
  thumbArgs,
  ensureThumb,
  THUMB_WIDTH,
  THUMB_DIRNAME,
  thumbRunCount,
  resetThumbRunCount,
  type StoredPhoto,
} from '../web/routes/photos-picker.js'
import { requiresAuth } from '../web/auth-gate.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const WEB = join(ROOT, 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const html = readFileSync(join(WEB, 'index.html'), 'utf8')
const css = readFileSync(join(WEB, 'style.css'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')
const server = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf8')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'photos-picker.ts'), 'utf8')
const authPy = readFileSync(join(ROOT, 'scripts', 'google-auth.py'), 'utf8')

/** Egy fuggveny torzse az app.js-bol, zarojel-parositassal. */
function extractFn(src: string, name: string): string {
  const start = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(src)
  if (!start) throw new Error(`nincs ilyen fuggveny: ${name}`)
  const from = src.indexOf('{', start.index + start[0].length - 1)
  let depth = 0
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start.index, i + 1) }
  }
  throw new Error(`nem zarodik be: ${name}`)
}

const photo = (over: Partial<StoredPhoto> = {}): StoredPhoto => ({
  id: 'AF1', account: 'lackor2', file: 'AF1.jpg', mimeType: 'image/jpeg',
  createdTime: '2026-08-01T10:00:00Z', width: 4000, height: 3000,
  isVideo: false, bytes: 1024, savedAt: '2026-08-14T20:00:00Z', ...over,
})

describe('hasPickerScope: elore megmondjuk, ki nem fog menni', () => {
  it('csak akkor igaz, ha a picker scope tenylegesen benne van', () => {
    expect(hasPickerScope({ scope: `x ${PICKER_SCOPE} y` })).toBe(true)
    expect(hasPickerScope({ scope: PICKER_SCOPE })).toBe(true)
  })

  it('a regi, csak Drive+Gmail fiok hamis -- ez a leggyakoribb eset', () => {
    // A refresh_token scope-halmaza a jovahagyaskor dol el es kesobb NEM bovul:
    // egy 2026 elott bekotott fiok tokenje ervenyes, de a Picker 403-at ad.
    expect(hasPickerScope({
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive',
    })).toBe(false)
  })

  it('a reszleges egyezes nem szamit engedelynek', () => {
    // Prefix/suffix trukk: a szokoz szerinti darabolas nelkul ezek atmennenek.
    expect(hasPickerScope({ scope: PICKER_SCOPE + '.evil' })).toBe(false)
    expect(hasPickerScope({ scope: 'https://evil/' + PICKER_SCOPE })).toBe(false)
  })

  it('hianyzo vagy rossz alaku bejegyzesnel nem dol el, hanem nem-et mond', () => {
    for (const bad of [null, undefined, 0, '', 'string', {}, { scope: null }, { scope: 42 }, []]) {
      expect(hasPickerScope(bad as unknown)).toBe(false)
    }
  })
})

describe('normalizeMediaItem: a Picker valasza -> a mi alakunk', () => {
  it('kepbol kiszedi az azonositot, a tipust, a datumot es a meretet', () => {
    const n = normalizeMediaItem({
      id: 'AF1QipX', createTime: '2026-07-04T08:15:00Z',
      mediaFile: { mimeType: 'image/jpeg', mediaFileMetadata: { width: 4032, height: 3024 } },
    }, 'lackor2')!
    expect(n).toEqual({
      id: 'AF1QipX', account: 'lackor2', mimeType: 'image/jpeg',
      createdTime: '2026-07-04T08:15:00Z', width: 4032, height: 3024, isVideo: false,
    })
  })

  it('a videot mind a mimeType, mind a videoMetadata alapjan felismeri', () => {
    // A Google mindketto agon jelezheti; ha elnezzuk, `=dv` helyett kepkent
    // probalnank lehozni, es nem kapnank hasznalhato fajlt.
    expect(normalizeMediaItem({ id: 'a', mediaFile: { mimeType: 'video/mp4' } }, 'x')!.isVideo).toBe(true)
    expect(normalizeMediaItem({
      id: 'b', mediaFile: { mimeType: 'image/jpeg', mediaFileMetadata: { videoMetadata: { fps: 30 } } },
    }, 'x')!.isVideo).toBe(true)
  })

  it('a hianyzo meret 0 lesz, nem undefined', () => {
    // A racs es a rendezes szamokat var; egy undefined vegigcsorogne az
    // indexen es a JSON-ban.
    const n = normalizeMediaItem({ id: 'a', mediaFile: { mimeType: 'image/png' } }, 'x')!
    expect(n.width).toBe(0)
    expect(n.height).toBe(0)
    expect(n.createdTime).toBe('')
  })

  it('azonosito vagy tipus nelkul nincs bejegyzes', () => {
    // Enelkul nev nelkuli fajlt irnank a lemezre, amit sose talalnank meg.
    expect(normalizeMediaItem({ mediaFile: { mimeType: 'image/jpeg' } }, 'x')).toBeNull()
    expect(normalizeMediaItem({ id: 'a', mediaFile: {} }, 'x')).toBeNull()
    expect(normalizeMediaItem({ id: 'a' }, 'x')).toBeNull()
    for (const bad of [null, undefined, 'string', 42]) expect(normalizeMediaItem(bad, 'x')).toBeNull()
  })
})

describe('mediaBytesUrl: a nyers baseUrl-t nem lehet letolteni', () => {
  it('kephez meretjelolest tesz, videohoz =dv-t', () => {
    expect(mediaBytesUrl('https://lh3.googleusercontent.com/abc', false)).toBe(
      `https://lh3.googleusercontent.com/abc=w${SAVE_WIDTH}-h${SAVE_WIDTH}`)
    expect(mediaBytesUrl('https://lh3.googleusercontent.com/abc', true)).toBe(
      'https://lh3.googleusercontent.com/abc=dv')
  })

  it('a meret felulirhato, de a video akkor is =dv marad', () => {
    expect(mediaBytesUrl('https://x/y', false, 256)).toBe('https://x/y=w256-h256')
    expect(mediaBytesUrl('https://x/y', true, 256)).toBe('https://x/y=dv')
  })

  it('ures baseUrl-bol nem gyartunk hivhato URL-t', () => {
    expect(mediaBytesUrl('', false)).toBe('')
    expect(mediaBytesUrl(null as unknown as string, false)).toBe('')
  })
})

describe('isAllowedPhotosUrl: a SZERVER keri le, ezert kapu kell ra', () => {
  it('a Google kep-kiszolgaloi atmennek', () => {
    expect(isAllowedPhotosUrl('https://lh3.googleusercontent.com/a=w100-h100')).toBe(true)
    expect(isAllowedPhotosUrl('https://photospicker.googleapis.com/v1/x')).toBe(true)
  })

  it('mas host, mas protokoll, es a belso halo nem', () => {
    // A szerver a belso halon van: egy elirt vagy megmergezett baseUrl SSRF.
    expect(isAllowedPhotosUrl('http://lh3.googleusercontent.com/a')).toBe(false)
    expect(isAllowedPhotosUrl('https://evil.com/a')).toBe(false)
    expect(isAllowedPhotosUrl('http://127.0.0.1:3420/api/vault')).toBe(false)
    expect(isAllowedPhotosUrl('file:///etc/passwd')).toBe(false)
  })

  it('a hasonlo nevu domainek nem csusznak at', () => {
    expect(isAllowedPhotosUrl('https://googleusercontent.com.evil.com/a')).toBe(false)
    expect(isAllowedPhotosUrl('https://notgoogleusercontent.com/a')).toBe(false)
    expect(isAllowedPhotosUrl('https://evilgoogleapis.com/a')).toBe(false)
  })

  it('a szemetet nem dobja el kivetellel', () => {
    for (const bad of ['', 'nem-url', '///', 'javascript:alert(1)']) {
      expect(isAllowedPhotosUrl(bad)).toBe(false)
    }
  })
})

describe('fajlnevek: a Google id-je nem irhat a konyvtaron kivulre', () => {
  it('kitorli a konyvtar-lepteto karaktereket', () => {
    expect(safePhotoFileName('../../etc/passwd', 'image/jpeg')).not.toContain('/')
    expect(safePhotoFileName('../../etc/passwd', 'image/jpeg')).not.toContain('..')
    expect(safeAccountDir('../../root')).not.toContain('/')
    expect(safeAccountDir('a\\b')).toBe('a_b')
  })

  it('a kiterjesztes a tipusbol jon, nem a nevbol', () => {
    expect(safePhotoFileName('AF1', 'image/jpeg')).toBe('AF1.jpg')
    expect(safePhotoFileName('AF1', 'image/png')).toBe('AF1.png')
    expect(safePhotoFileName('AF1', 'video/mp4')).toBe('AF1.mp4')
    // Ismeretlen kep-tipus is megnyithato fajl legyen, ne kiterjesztes nelkuli.
    expect(safePhotoFileName('AF1', 'image/heic')).toBe('AF1.jpg')
  })

  it('ures vagy csupa tiltott karakterbol allo bemenet is hasznalhato nevet ad', () => {
    expect(safePhotoFileName('', 'image/jpeg')).toBe('kep.jpg')
    expect(safePhotoFileName('///', 'image/jpeg')).toBe('___.jpg')
    expect(safeAccountDir('')).toBe('default')
  })

  it('a nagyon hosszu id-t levagja, de kulon marad', () => {
    const a = safePhotoFileName('A'.repeat(400), 'image/jpeg')
    expect(a.length).toBeLessThanOrEqual(124)
    expect(safeAccountDir('b'.repeat(200)).length).toBe(64)
  })
})

describe('sortPhotos: legujabb elol', () => {
  it('keszitesi ido szerint csokkenoen rendez', () => {
    const list = [
      photo({ id: 'regi', createdTime: '2020-01-01T00:00:00Z' }),
      photo({ id: 'uj', createdTime: '2026-08-01T00:00:00Z' }),
      photo({ id: 'kozep', createdTime: '2024-05-05T00:00:00Z' }),
    ]
    expect(sortPhotos(list).map((p) => p.id)).toEqual(['uj', 'kozep', 'regi'])
  })

  it('datum nelkuli kep a lementes ideje szerint sorolodik, nem a lista vegere', () => {
    const list = [
      photo({ id: 'datum-nelkul', createdTime: '', savedAt: '2026-08-14T00:00:00Z' }),
      photo({ id: 'regi', createdTime: '2020-01-01T00:00:00Z' }),
    ]
    expect(sortPhotos(list)[0].id).toBe('datum-nelkul')
  })

  it('nem irja at a kapott listat', () => {
    const list = [photo({ id: 'a', createdTime: '2020-01-01T00:00:00Z' }), photo({ id: 'b', createdTime: '2026-01-01T00:00:00Z' })]
    sortPhotos(list)
    expect(list.map((p) => p.id)).toEqual(['a', 'b'])
  })
})

describe('humanBytes', () => {
  it('a hatarokon is ertelmes', () => {
    expect(humanBytes(0)).toBe('0 B')
    expect(humanBytes(1023)).toBe('1023 B')
    expect(humanBytes(1024)).toBe('1 KB')
    expect(humanBytes(1024 * 1024)).toBe('1.0 MB')
    expect(humanBytes(1024 * 1024 * 1024)).toBe('1.00 GB')
  })

  it('a szemetbol 0 lesz, nem NaN', () => {
    for (const bad of [NaN, null, undefined, 'sok']) expect(humanBytes(bad as unknown as number)).toBe('0 B')
  })
})

describe('a vegpontok fel vannak kotve', () => {
  it('a web.ts hivja a Fotok utvonalkezelot', () => {
    expect(server).toContain("from './web/routes/photos-picker.js'")
    expect(server).toMatch(/if \(await tryHandlePhotosPicker\(routeCtx\)\) return/)
  })

  it('mind a hat vegpont letezik', () => {
    for (const p of ['/api/photos/accounts', '/api/photos/list', '/api/photos/media',
      '/api/photos/session', '/api/photos/remove', '/api/photos/usage']) {
      expect(route.includes(`path === '${p}'`), p).toBe(true)
    }
  })

  it('a maganfenykep NEM nyilvanos vegpont', () => {
    // Az avatar-utvonalak szandekosan hitelesites-mentesek; ha valaki a kepeket
    // is oda venne fel, barki lekerhetne a Boss fotoit.
    expect(requiresAuth('/api/photos/media', 'GET')).toBe(true)
    expect(requiresAuth('/api/photos/list', 'GET')).toBe(true)
    expect(requiresAuth('/api/photos/session', 'POST')).toBe(true)
    expect(requiresAuth('/api/marveen/avatar', 'GET')).toBe(false)  // kontroll
  })
})

describe('a szerver a mert korlatokat koveti', () => {
  it('a picker scope benne van a google-auth.py-ban', () => {
    // Enelkul minden fiok 403 PERMISSION_DENIED-t kap -- ezt elore lemertuk.
    expect(authPy).toContain('photospicker.mediaitems.readonly')
  })

  it('a baseUrl-lekereshez bearer fejlec megy', () => {
    // A Drive alairt thumbnailLink-jevel ELLENTETES szabaly: a Picker
    // baseUrl-je fejlec nelkul 401-et ad.
    expect(route).toMatch(/fetch\(url, \{ headers: \{ Authorization: `Bearer \$\{token\}` \} \}\)/)
  })

  it('minden kep utan menti az indexet, nem a vegen egyszer', () => {
    // A baseUrl 60 percig el, es a bongeszo bezarhato: ami lejott, az maradjon
    // meg akkor is, ha a tobbi elhasal.
    const body = /async function downloadPickedNow\([\s\S]*?\n\}/.exec(route)![0]
    expect(body).toMatch(/saved\+\+\n\s*saveIndex\(index\)/)
    expect(body).toMatch(/known\.has\(`\$\{account\}:\$\{norm\.id\}`\)/)  // ugyanaz ketszer nem jon le
  })

  it('a letoltes elott ellenorzi a cel-hostot', () => {
    const body = /async function downloadPickedNow\([\s\S]*?\n\}/.exec(route)![0]
    expect(body).toMatch(/!isAllowedPhotosUrl\(url\)/)
  })

  it('a serult index nem torolheti el a kepeket, es nem dobja el az oldalt', () => {
    // Valodi meres, nem szoveg-egyezes: felig kiirt index.json-t teszunk le,
    // es elvarjuk, hogy a lista ures legyen, a FAJLOK viszont maradjanak.
    const dir = join(PROJECT_ROOT, 'store', 'photos')
    const idx = join(dir, 'index.json')
    const had = existsSync(idx) ? readFileSync(idx, 'utf8') : null
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(idx, '[{"id":"AF1","acc')  // megszakadt iras
      expect(loadIndex()).toEqual([])
      expect(existsSync(idx)).toBe(true)
    } finally {
      if (had === null) rmSync(idx, { force: true })
      else writeFileSync(idx, had)
    }
  })

  it('a media-vegpont csak az indexben szereplo fajlt adja ki', () => {
    // Igy a kliens nem tud utvonalat "kitalalni", meg akkor sem, ha a
    // fajlnev-tisztitas valaha elromlana.
    expect(route).toMatch(/const entry = loadIndex\(\)\.find\(\(p\) => p\.id === id && p\.account === account\)/)
    expect(route).toMatch(/'Cache-Control': 'private, max-age=86400'/)
  })

  it('engedely nelkuli fioknal nevesitett hibat ad, nem nyers 403-at', () => {
    expect(route).toMatch(/code: 'no_scope'/)
    expect(route).toMatch(/hasPickerScope\(tokenEntry\(account\)\)/)
  })
})

describe('a Fotok oldalon SOHA nincs Drive-fajl', () => {
  const photosJs = app.slice(app.indexOf('// Fotok oldal -- KIZAROLAG Google Fotok'),
    app.indexOf('function renderVaultKnownIntegrations'))

  it('a modul megvan es kulon all', () => {
    expect(photosJs.length).toBeGreaterThan(2000)
  })

  it('egyetlen Drive-vegpontot sem hiv', () => {
    // Boss: "Nem akarok latni drive fileket a fotokban. semmit. akkor sem ha
    // azok fotok!" -- ez a szabaly egy sorban.
    expect(photosJs).not.toMatch(/\/api\/drive\//)
    expect(photosJs).not.toMatch(/googleapis\.com\/drive/)
  })

  // A Fotok-engedely folyamata (2026-08-15) a kozos Google-bejelentkezteto
  // vegpontokat hasznalja. Ezek nem ADATFORRASOK: nem adnak vissza fajlt,
  // se listat -- egy jovahagyo linket adnak, es a folyamat allapotat. A
  // szabaly, amit a Boss kimondott ("Nem akarok latni drive fileket a
  // fotokban"), tehat sertetlen; a lista viszont ZART, hogy egy kesobbi
  // "csak ez az egy" ne tudjon eszrevetlenul adatforrast behozni.
  const AUTH_ENDPOINTS = new Set([
    '/api/connections/google/login',
    '/api/connections/google/login/paste',
    '/api/connections/google/login/cancel',
  ])

  it('minden ADATLEKERESE a /api/photos/ alol jon', () => {
    const urls = [...photosJs.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1])
    expect(urls.length).toBeGreaterThan(3)
    const data = urls.filter((u) => !AUTH_ENDPOINTS.has(u))
    expect(data.length, 'csak auth-hivas maradt, adatlekeres egy sem').toBeGreaterThan(3)
    for (const u of data) expect(u.startsWith('/api/photos/'), u).toBe(true)
  })

  it('a kivetel-lista tenyleg csak a bejelentkeztetesre szol', () => {
    for (const u of AUTH_ENDPOINTS) {
      expect(u.startsWith('/api/connections/google/login'), u).toBe(true)
    }
  })
})

describe('a kliens a bajtokat fetch-csel hozza le', () => {
  it('a csempe <img>-je src nelkul szuletik', () => {
    // Ez a "gy file" letoltes-hiba tanulsaga: navigacio/kepbetoltes nem viszi
    // a Bearer fejlecet, es a 401 JSON-t kapnank kep helyett.
    const tile = extractFn(app, '_photosTileHtml')
    expect(tile).toMatch(/<img alt=/)
    expect(tile).not.toMatch(/<img[^>]*src=/)
  })

  it('a nagy nezet sem tesz nyers utvonalat az img-be', () => {
    const box = extractFn(app, '_photosOpenLightbox')
    expect(box).not.toMatch(/src\s*=\s*['"`]\/api\//)
  })

  it('a kepbetolto fetch + blob URL-t hasznal', () => {
    const load = extractFn(app, '_photosLoadImage')
    expect(load).toMatch(/URL\.createObjectURL/)
    expect(load).toMatch(/_photoBlobUrls\.push/)
    // A cim eloallitasa es a letoltes kulon lepes lett (bolyeg vs. teljes kep,
    // illetve bongeszo-tar), de a lenyeg valtozatlan: fetch, nem <img src>.
    expect(extractFn(app, '_photosMediaUrl')).toMatch(/'\/api\/photos\/media\?id='/)
    expect(extractFn(app, '_photosMediaUrl')).toMatch(/encodeURIComponent\(id\)/)
    expect(extractFn(app, '_photosFetchMedia')).toMatch(/fetch\(url\)/)
  })

  it('a blob URL-eket elengedjuk, kulonben elszivarog a memoria', () => {
    expect(extractFn(app, '_photosReleaseBlobs')).toMatch(/URL\.revokeObjectURL/)
    expect(extractFn(app, 'loadPhotosPage')).toMatch(/_photosReleaseBlobs\(\)/)
    expect(extractFn(app, '_photosRefresh')).toMatch(/_photosReleaseBlobs\(\)/)
    // Az oldalt elhagyva sem maradhatnak bent, es a lekerdezes sem futhat tovabb.
    expect(app).toMatch(/if \(pageId !== 'photos'\) \{ _photosStopPoll\(\); _photosReleaseBlobs\(\) \}/)
  })

  it('a nagy nezet a racsban mar letoltott kepet hasznalja ujra', () => {
    expect(extractFn(app, '_photosOpenLightbox')).toMatch(/if \(alreadyLoadedUrl\) img\.src = alreadyLoadedUrl/)
    expect(extractFn(app, '_photosBindTiles')).toMatch(/tile\.querySelector\('img'\)\?\.src/)
  })
})

describe('a Picker-folyamat vegigvezeti a felhasznalot', () => {
  it('a valaszto uj lapon nyilik, mert iframe-be nem teheto', () => {
    const start = extractFn(app, '_photosStartPicker')
    expect(start).toMatch(/window\.open\(data\.pickerUri, '_blank'\)/)
    // A Google X-Frame-Options-szal tiltja a beagyazast: egy iframe ures
    // keretet adna, es a Boss azt hinne, elromlott.
    expect(start).not.toMatch(/iframe/i)
  })

  it('blokkolt felugronal szol, nem porog vegtelenul', () => {
    const start = extractFn(app, '_photosStartPicker')
    expect(start).toMatch(/photos\.popup_blocked/)
    // Elobb nyitunk lapot, csak utana varakozunk -- kulonben a "varok" doboz
    // ottmaradna egy meg sem nyilt valaszto miatt.
    expect(start.indexOf('window.open')).toBeLessThan(start.indexOf("photosWaiting'"))
  })

  it('a lekerdezes suruseget a Google mondja meg, es meg van fogva', () => {
    // Sajat idozites rate limitet hozna; a hatarok azert kellenek, hogy egy
    // hibas ertek se verje szet a szervert, se ne tunjon lefagyasnak.
    const ms = extractFn(app, '_photosPollMs')
    expect(ms).toMatch(/Math\.min\(30000, Math\.max\(2000/)
    expect(extractFn(app, '_photosStartPicker')).toMatch(/_photosPollMs\(data\.pollInterval\)/)
  })

  it('a lekerdezes minden kimeneten megall -- hiba, keszultseg, megsem', () => {
    // Kulon-kulon mind a harom kijaratra: egy bent felejtett setInterval a
    // hattetben verne a szervert, amig a lap nyitva van.
    const poll = extractFn(app, '_photosPoll')
    // A leallitas a hibaag ELSO lepese legyen: barmi jon utana (pl. az
    // "api_disabled" doboz), a pollozas addigra mar all. Az alakjahoz nem
    // kotjuk magunkat -- a sorrend a szabaly, nem a tordeles.
    expect(poll, 'szerver-hiba').toMatch(/if \(!res\.ok\) \{\s*_photosStopPoll\(\)/)
    expect(poll, 'elkeszult').toMatch(/if \(!data\.done\) return\n\s*_photosStopPoll\(\)/)
    // A halozati kivetel agan is meg kell allni. Egyetlen dolog elozi meg: az
    // elavult kor kiszurese -- egy mar leallitott kor kivetele nem allithatja
    // le a helyette elindult friss kort (404-verseny, lasd lentebb).
    const catchBlock = poll.slice(poll.lastIndexOf('} catch {'))
    expect(catchBlock, 'halozati kivetel').toMatch(/_photosStopPoll\(\)/)
    expect(catchBlock, 'elavult kor szurese').toMatch(/gen !== _photosPollGen/)
    expect(extractFn(app, '_photosStopPoll')).toMatch(/clearInterval\(_photosPollTimer\)/)
    expect(app).toMatch(/getElementById\('photosCancelBtn'\)\?\.addEventListener\('click', _photosStopPoll\)/)
  })

  it('a lekerdezes a session INDITASAKOR ervenyes fiokra megy', () => {
    // Kozben a Boss atvalthat masik fiokra: a valasz akkor is ahhoz a fiokhoz
    // tartozik, amelyikkel a session indult.
    expect(extractFn(app, '_photosPoll')).toMatch(/const account = _photosAccount/)
  })

  it('engedely nelkuli fiokot nem enged inditani', () => {
    expect(extractFn(app, '_photosRefresh')).toMatch(/addBtn\.disabled = !ready/)
    expect(extractFn(app, '_photosStartPicker')).toMatch(/data\.code === 'no_scope'/)
  })
})

describe('a "nincs meg engedely" allapot kezzelfoghato', () => {
  // Elozo valtozat: a doboz kiirta a `python3 scripts/google-auth.py auth <fiok>`
  // parancsot. Boss (2026-08-15) ezt a Windows PowerShellbe masolta be, ahol
  // nincs is python3 -- vagyis a "be van irva a parancs" nem oldotta meg, amit
  // meg kellett volna: "nem tudnad ezt megcsinalni ugy hogy a marveen ban
  // automatan megcsinalja ezt a parancsfuttatast [...] es a usernak odaadja a
  // linket amit generalt a rendszer?". Terminal-parancs helyett egy gomb.
  it('SEMMILYEN terminal-parancsot nem ker a felhasznalotol', () => {
    expect(app).not.toContain('python3 scripts/google-auth.py auth')
    expect(html).not.toContain('id="photosConsentCmd"')
  })

  it('egy gomb inditja a folyamatot', () => {
    expect(html).toContain('id="photosConsentBtn"')
    // Nyilas fuggveny, NEM a fuggveny neve. A kezelo elso argumentuma az Event
    // lenne, ami a `force` parameter helyere csuszva minden elso kattintasnal
    // kiloné valaki mas, jogosan futo bejelentkeztetest (google-auth-busy.test.ts).
    expect(app).toMatch(/getElementById\('photosConsentBtn'\)\?\.addEventListener\('click', \(\) => _photosConsentStart\(\)\)/)
  })

  it('a szerver altal generalt linket adja oda', () => {
    // A SZABALY: a lathato link kizarolag a szerver friss valaszabol jon.
    // Hogy EZ hogyan tortenik, mar nem itt rogzitjuk: a kozvetlen
    // `link.href = s.url` volt maga a hiba (a doboz megtartotta az elozo
    // folyamat linkjet), ezert minden iras a _setConsentLink-en megy at.
    // A torles-mielott-megjelenik sorrendet a consent-link-stale.test.ts orzi.
    const tick = extractFn(app, '_photosConsentTick')
    expect(tick).toMatch(/fetch\('\/api\/connections\/google\/login'\)/)
    expect(tick, 'a linket a szerver s.url-jebol kell beallitani').toMatch(/_setConsentLink\('photosConsentLink', s\.url\)/)
    expect(html).toContain('id="photosConsentLink"')
  })

  it('a MEGLEVO fiok id-jat kuldi, nem uj nevet -- kulonben "lackor2_2" lenne', () => {
    // A nev-agon a szerver de-duplikal (suggestAccountId), es egy uj fiokba
    // jelentkeztetne be; a Fotok oldal meg tovabbra is az engedely nelkuli
    // regit nezne, vagyis a gomb latszolag nem csinalna semmit.
    // A SZABALY az, hogy `id`-t kuld es sosem `name`-et -- nem az, hogy hany
    // mezo van a torzsben (a `force` ota ket alakja van ugyanannak).
    const start = extractFn(app, '_photosConsentStart')
    expect(start).toMatch(/JSON\.stringify\([^)]*\{ id: account/)
    expect(start, 'nev-agon a szerver de-duplikalna').not.toMatch(/name: account/)
  })

  it('siker utan magatol ujratolt -- nem a usernek kell frissitenie', () => {
    const tick = extractFn(app, '_photosConsentTick')
    expect(tick).toMatch(/s\.phase === 'done'/)
    expect(tick).toMatch(/await loadPhotosPage\(\)/)
  })

  it('van kezi tartalek is, ha a loopback-atiranyitas nem er ide', () => {
    expect(extractFn(app, '_photosConsentSendPaste'))
      .toMatch(/fetch\('\/api\/connections\/google\/login\/paste'/)
    expect(html).toContain('id="photosConsentPaste"')
  })

  // A bejelentkeztetes globalis: egyszerre EGY futhat (google-auth-runner.ts
  // "Mar fut egy Google-bejelentkeztetes (...)"). Ha a Kapcsolatok oldalon epp
  // fut egy, a Fotok gombja ok:false-t kap. Ilyenkor nyitva hagyni a dobozt
  // azert veszelyes, mert a benne levo "Megse" a MASIK, jogosan futo folyamatot
  // szakitana meg -- ezert becsukjuk, es buborekban mondjuk el a hibat.
  it('sikertelen inditasnal becsukja a dobozt, nem hagy ott idegen "Megse"-t', () => {
    // A SZABALY: minden sikertelen inditasi ag becsukja a dobozt. Az egyetlen
    // kivetel a "mar fut egy masik" (`code: 'busy'`), ami sajat kerdest tesz
    // fel -- de az is _photosConsentReset()-tel kezd, lasd google-auth-busy.
    const start = extractFn(app, '_photosConsentStart')
    expect(start).toMatch(/if \(!data\.ok\) \{[\s\S]*?_photosConsentFail\(/)
    expect(start).toMatch(/catch \(err\) \{\s*_photosConsentFail\(/)
    const fail = extractFn(app, '_photosConsentFail')
    expect(fail).toMatch(/_photosConsentReset\(\)/)
    expect(fail).toMatch(/showToast\(msg/)
  })

  it('a lekerdezes leall, ha vege -- kulonben orokke pollozna a hatterben', () => {
    const reset = extractFn(app, '_photosConsentReset')
    expect(reset).toMatch(/clearInterval\(_photosConsentPoll\)/)
    expect(reset).toMatch(/_photosConsentPoll = null/)
    // Hiba eseten is: a 'failed' ag sajat kezuleg allitja le.
    expect(extractFn(app, '_photosConsentTick')).toMatch(/s\.phase === 'failed'[\s\S]{0,200}clearInterval/)
  })

  it('elnavigalaskor is leall -- ahogy a tobbi elo lekerdezes a hazban', () => {
    // A switchPage mar igy banik az Aktivitas/Ugynokok/Kanban pollokkal.
    expect(extractFn(app, 'switchPage')).toMatch(/if \(pageId !== 'photos'\) _photosConsentReset\(\)/)
  })

  it('egy lassu valasz nem futtatja le megegyszer a befejezest', () => {
    // 2 mp-es pollozasnal ket lekerdezes atfedhet; a masodik ne csinaljon
    // dupla ertesitest es dupla ujratoltest a mar lezart folyamatra.
    const tick = extractFn(app, '_photosConsentTick')
    const guard = tick.indexOf('if (!_photosConsentPoll) return')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(tick.indexOf("s.phase === 'done'"))
  })

  it('fiokvaltaskor becsukja a masik fiokhoz tartozo folyamatot', () => {
    expect(extractFn(app, '_photosRefresh'))
      .toMatch(/_photosConsentFor && _photosConsentFor !== _photosAccount.*_photosConsentReset\(\)/)
  })

  // Ket fajl kozti NEMA szerzodes: a gomb azt a szot kuldi vissza `id`-kent,
  // amit a fioklista `name`-kent adott. Ha valaki a listat "szepitene" (pl.
  // e-mail cimre vagy nagybetusre), a bejelentkeztetes egy MASIK fiokba menne
  // -- a gomb latszolag nem csinalna semmit. Ezert a nyers kulcs megy at.
  it('a fioklista a nyers fiok-kulcsot adja, amit a login vissza is vesz', () => {
    expect(route).toMatch(/accounts: accounts\.map\(\(a\) => \(\{ name: a, ready:/)
    // Merve: /api/photos/accounts -> name:"lackor2", es a Kapcsolatok
    // ugyanezt a fiokot id:"lackor2" neven ismeri (2026-08-15).
    const conn = readFileSync(join(ROOT, 'src', 'web', 'routes', 'connections.ts'), 'utf8')
    expect(conn).toMatch(/suggestAccountId\(wanted, str\(b\.id\)\.trim\(\) \? \[\] : taken\)/)
  })

  it('a fioklistan latszik, melyiknel nincs engedely', () => {
    expect(extractFn(app, 'loadPhotosPage')).toMatch(/a\.ready \? '' : ' - ' \+ escapeHtml\(t\('photos\.account_no_scope'\)\)/)
  })

  it('alapbol olyan fiokot valaszt, amelyiknel mar megvan az engedely', () => {
    expect(extractFn(app, 'loadPhotosPage')).toMatch(/const ready = accounts\.find\(a => a\.ready\)/)
  })
})

describe('a markup es a stilus egyutt all', () => {
  it('a Fotok oldal es a menupont letezik', () => {
    expect(html).toMatch(/<div class="page" id="photosPage" hidden>/)
    expect(html).toMatch(/data-page="photos"/)
    expect(html).toMatch(/data-i18n="nav\.photos"/)
  })

  it('minden azonosito, amit a JS keres, megvan a HTML-ben', () => {
    const ids = [...app.slice(app.indexOf('// Fotok oldal -- KIZAROLAG Google Fotok'),
      app.indexOf('function renderVaultKnownIntegrations'))
      .matchAll(/getElementById\('(photo[A-Za-z]*)'\)/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(5)
    for (const id of new Set(ids)) expect(html.includes(`id="${id}"`), id).toBe(true)
  })

  it('a rejtett dobozokat tenyleg el is tunteti a CSS', () => {
    // Ismetlodo hiba a hazban: `.foo { display: flex }` legyozi a bongeszo
    // [hidden] szabalyat, es a doboz ottmarad a kepernyon.
    for (const cls of ['photos-waiting', 'photo-lightbox', 'photos-consent']) {
      expect(new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(css), cls).toBe(true)
    }
    // Az engedely-folyamat a dobozon BELUL is rejtve indul, es a
    // `.claude-auth-flow` sajat display-t kap -- ezert kell a sajat szabalya.
    expect(css).toMatch(/\.photos-consent \.claude-auth-flow\[hidden\]\s*\{[^}]*display\s*:\s*none/)
  })

  it('a racs es a csempe stilusa megvan', () => {
    // Valodi szelektort varunk, nem puszta szovegtalalatot: a `css.includes`
    // akkor is zold volt, ha az osztaly CSAK egy kommentben szerepel (a
    // fajlban van is ilyen komment a regi parancs-dobozrol) -- vagyis a
    // stilus torlese eszrevetlen maradhatott volna.
    for (const cls of ['photos-grid', 'photo-tile', 'photo-tile-thumb', 'photo-tile-badge',
      'photo-lightbox-stage', 'photos-consent']) {
      expect(new RegExp(`^\\.${cls}[ ,{:[]`, 'm').test(css), cls).toBe(true)
    }
  })

  it('a csempe fix aranyu, hogy a racs ne ugraljon betoltes kozben', () => {
    expect(css).toMatch(/\.photo-tile-thumb \{[^}]*aspect-ratio/)
  })
})

// Boss, 2026-08-15 -- ezt kapta nyersen a feluleten:
//   Picker API 403: { "error": { "code": 403, "message": "Google Photos Picker
//   API has not been used in project 634577308953 before or it is disabled..." } }
// Ez NEM engedely-hiany: a fiokkal minden rendben, a projektben nincs
// bekapcsolva az API. Ujra-bejelentkeztetessel sosem oldodik meg, tehat a
// felulet rossz helyre kuldene a felhasznalot.
describe('"a projektben nincs bekapcsolva az API" kulon eset', () => {
  const REAL = 'Picker API 403: {"error":{"code":403,"message":"Google Photos Picker API has not '
    + 'been used in project 634577308953 before or it is disabled. Enable it by visiting '
    + 'https://console.developers.google.com/apis/api/photospicker.googleapis.com/overview'
    + '?project=634577308953 then retry.","status":"PERMISSION_DENIED"}}'

  it('felismeri a valodi Google-uzenetet, es kiszedi a projekt szamat', () => {
    const hit = pickerApiDisabled(REAL)
    expect(hit).not.toBeNull()
    expect(hit!.projectNumber).toBe('634577308953')
    expect(hit!.url).toBe('https://console.cloud.google.com/apis/library/photospicker.googleapis.com?project=634577308953')
  })

  it('a scope-hianyos 403-at NEM keveri ossze ezzel', () => {
    // Erre mas a teendo: ott tenyleg ujra kell kerni az engedelyt.
    expect(pickerApiDisabled('Picker API 403: {"error":{"message":"Request had insufficient '
      + 'authentication scopes.","status":"PERMISSION_DENIED"}}')).toBeNull()
  })

  it('a linket MI epitjuk -- az uzenetbe csempeszett cim nem lesz belole link', () => {
    // A hibauzenet kulso adat. Ha a benne levo cimet adnank tovabb, egy
    // valaszthato-tartalmu mezo eleg lenne ahhoz, hogy a sajat feluletunk
    // mutasson idegen oldalra.
    const hit = pickerApiDisabled('API has not been used in project 42424242 before. '
      + 'Enable it by visiting https://evil.example/apis?project=42424242 then retry.')
    expect(hit!.url.startsWith('https://console.cloud.google.com/')).toBe(true)
    expect(hit!.url).not.toContain('evil.example')
  })

  it('projektszam nelkul is hasznalhato linket ad', () => {
    const hit = pickerApiDisabled('The API is disabled (SERVICE_DISABLED).')
    expect(hit!.projectNumber).toBe('')
    expect(hit!.url).toBe('https://console.cloud.google.com/apis/library/photospicker.googleapis.com')
  })

  it('mindket helyen felismeri: inditasnal ES a valasztas kozben is', () => {
    const hits = [...route.matchAll(/code: 'api_disabled'/g)]
    expect(hits.length).toBe(2)
    expect(route).toMatch(/err\.status === 403 \? pickerApiDisabled\(err\.message \|\| ''\) : null/)
  })

  it('a felulet emberi dobozt mutat, nem a nyers JSON-t', () => {
    expect(html).toContain('id="photosApiDisabledBox"')
    expect(html).toContain('id="photosApiDisabledLink"')
    expect(html).toContain('id="photosApiDisabledRetryBtn"')
    expect(extractFn(app, '_photosStartPicker'))
      .toMatch(/data\.code === 'api_disabled' && _photosShowApiDisabled\(data\)/)
    expect(extractFn(app, '_photosPoll'))
      .toMatch(/data\.code === 'api_disabled' && _photosShowApiDisabled\(data\)/)
  })

  it('a bongeszo is ellenorzi a gazdagepet, mielott linket csinal belole', () => {
    const show = extractFn(app, '_photosShowApiDisabled')
    expect(show).toMatch(/startsWith\('https:\/\/console\.cloud\.google\.com\/'\)/)
    // ...es ha nem az, NEM nyeli el a hibat: a hivo a nyers uzenetet mutatja.
    expect(show).toMatch(/return false/)
  })

  it('a doboz eltunik, amint az oldal ujrarajzolodik', () => {
    expect(extractFn(app, '_photosRefresh')).toMatch(/_photosHideApiDisabled\(\)/)
  })

  it('van "Ujraprobalom" gomb, ami tenyleg ujraprobalja', () => {
    expect(app).toMatch(/getElementById\('photosApiDisabledRetryBtn'\)\?\.addEventListener\('click'[\s\S]{0,160}_photosStartPicker\(\)/)
  })

  it('stilusa van, es rejtve indul', () => {
    expect(new RegExp('^\\.photos-apidisabled[ ,{:[]', 'm').test(css)).toBe(true)
    expect(css).toMatch(/\.photos-apidisabled\[hidden\]\s*\{[^}]*display\s*:\s*none/)
  })
})

// Boss, 2026-08-15 -- a HARMADIK hibafajta, megint nyersen a feluleten:
//   Picker API 400: { "error": { "code": 400, "message": "The user must have a
//   Google Photos account to perform that action. Please try again after the
//   user sets up a Google Photos account.", "status": "FAILED_PRECONDITION" } }
// Se engedely-hiany, se kikapcsolt API: ezzel a Google-fiokkal soha nem
// hasznaltak a Google Fotokat. Tiz bekotott fioknal ez varhato eset.
describe('"ehhez a fiokhoz nincs Google Fotok" kulon eset', () => {
  const REAL = 'Picker API 400: {"error":{"code":400,"message":"The user must have a Google Photos '
    + 'account to perform that action. Please try again after the user sets up a Google Photos '
    + 'account.","status":"FAILED_PRECONDITION"}}'

  it('felismeri a valodi Google-uzenetet', () => {
    expect(pickerNoPhotosAccount(REAL)).toBe(true)
  })

  it('a masik ket hibafajtat NEM huzza ide', () => {
    // Mindharomra MAS a teendo, es a rossz doboz rosszabb a nyers hibanal:
    // oda kuldi a felhasznalot, ahol semmit nem tud megoldani.
    expect(pickerNoPhotosAccount('Picker API 403: {"error":{"message":"Request had insufficient '
      + 'authentication scopes.","status":"PERMISSION_DENIED"}}')).toBe(false)
    expect(pickerNoPhotosAccount('Picker API 403: {"error":{"message":"Google Photos Picker API '
      + 'has not been used in project 634577308953 before or it is disabled."}}')).toBe(false)
    expect(pickerApiDisabled(REAL)).toBeNull()
    // A "Google Photos" szavak onmagukban NEM eleg: a Google sok mas hibaja is
    // leirja a szolgaltatas nevet, es a rossz doboz oda kuldene a felhasznalot,
    // ahol nincs mit tennie. A dontes a "Google Photos ACCOUNT" fordulaton all
    // -- ezt a hatart itt egy olyan uzenet feszegeti, ami minden MAS jelet
    // tartalmaz (FAILED_PRECONDITION, "must have", "set up"), csak ezt nem.
    expect(pickerNoPhotosAccount('Picker API 400: {"error":{"message":"The Google Photos Picker '
      + 'session must have at least one media item. Please set up the session again.",'
      + '"status":"FAILED_PRECONDITION"}}')).toBe(false)
  })

  it('mas FAILED_PRECONDITION-t nem nyel le', () => {
    // A 400-at sok minden okozhatja; csak a nevezetes mondat a mienk.
    expect(pickerNoPhotosAccount('Picker API 400: {"error":{"message":"Session is not ready.",'
      + '"status":"FAILED_PRECONDITION"}}')).toBe(false)
    expect(pickerNoPhotosAccount('')).toBe(false)
  })

  it('mindket helyen felismeri: inditasnal ES a valasztas kozben is', () => {
    const hits = [...route.matchAll(/code: 'no_photos_account'/g)]
    expect(hits.length).toBe(2)
    // 409: nem szerverhiba (502) -- a fiok allapota olyan, hogy ez a muvelet
    // most nem vegezheto el; a javitas utan ugyanaz a gomb mukodni fog.
    // MINDKETTOT szamoljuk: egy darab helyes talalat elfedne, ha a masik agon
    // elcsuszna a statusz (a szabotazs-proba pontosan igy csuszott at).
    expect([...route.matchAll(/code: 'no_photos_account', account \}, 409\)/g)].length).toBe(2)
  })

  it('a felulet emberi dobozt mutat, nem a nyers JSON-t', () => {
    expect(html).toContain('id="photosNoPhotosBox"')
    expect(html).toContain('id="photosNoPhotosRetryBtn"')
    expect(extractFn(app, '_photosStartPicker'))
      .toMatch(/data\.code === 'no_photos_account' && _photosShowNoPhotosAccount\(data\)/)
    expect(extractFn(app, '_photosPoll'))
      .toMatch(/data\.code === 'no_photos_account' && _photosShowNoPhotosAccount\(data\)/)
  })

  it('a link a MI oldalunkon all, nem a Google hibauzenetebol jon', () => {
    // Itt meg annyi mozgastere sincs a kulso adatnak, mint az api_disabled
    // againal: a cim allando, ezert a markupban all, a szerver valaszabol
    // pedig semmilyen url-t nem olvasunk ki.
    expect(html).toMatch(/id="photosNoPhotosLink"[^>]*href="https:\/\/photos\.google\.com\/"/)
    const show = extractFn(app, '_photosShowNoPhotosAccount')
    expect(show, 'a szerver uzenetebol nem lehet link').not.toMatch(/href/)
  })

  it('megmondja, MELYIK fiokrol van szo', () => {
    // Tiz bekotott fioknal a "valamelyik fiokoddal baj van" hasznalhatatlan.
    expect(extractFn(app, '_photosShowNoPhotosAccount')).toMatch(/photos\.nophotos_account/)
    expect(html).toContain('id="photosNoPhotosAccount"')
  })

  it('van "Ujraprobalom" gomb, ami tenyleg ujraprobalja', () => {
    expect(app).toMatch(/getElementById\('photosNoPhotosRetryBtn'\)\?\.addEventListener\('click'[\s\S]{0,200}_photosStartPicker\(\)/)
  })

  it('a session_gone 404-et NEM keveri ossze ezzel', () => {
    expect(pickerNoPhotosAccount('Picker API 404: {"error":{"message":"The entity you requested '
      + 'does not exist.","status":"NOT_FOUND"}}')).toBe(false)
  })

  it('a MEGOLDOTT hiba nem marad a kepernyon', () => {
    // Ugyanaz a hibafajta, mint a regi jovahagyo link: ha a doboz ott marad,
    // a felhasznalo egy mar elintezett bajt lat, es ujra nekiall javitani.
    const start = extractFn(app, '_photosStartPicker')
    expect(start).toMatch(/_photosHideNoPhotosAccount\(\)/)
    expect(start).toMatch(/_photosHideApiDisabled\(\)/)
    expect(start, 'a regi hibaszoveg is tunjon el').toMatch(/_photosSetError\(''\)/)
    // ...es a sorrend: eloszor takaritunk, csak utana kerdezzuk a szervert.
    expect(start.indexOf('_photosHideNoPhotosAccount()')).toBeLessThan(start.indexOf("fetch('/api/photos/session'"))
    expect(extractFn(app, '_photosRefresh')).toMatch(/_photosHideNoPhotosAccount\(\)/)
  })
})

// Boss, 2026-08-15 -- a NEGYEDIK nyers hiba a feluleten:
//   Picker API 404: { "error": { "code": 404, "message": "The entity you
//   requested does not exist.", "status": "NOT_FOUND", ... ENTITY_NOT_FOUND }}
//
// Ez nem onallo hiba volt, hanem egy VERSENYHELYZET tunete. A kerdezo hurok
// `setInterval`-lal ment, ami nem varja meg az elozo kort. Amig a valasztas
// tart, a valasz azonnal jon ("meg nem"), de amint kesz, a szerver ELKEZDI
// lehozni a kepeket -- ez sok kepnel tovabb tart, mint a kerdezes koze. Igy ket
// keres futott ugyanarra a session-re: az elso vegzett es elengedte a session-t,
// a masodik pedig a mar nem letezot kerdezte. Innen a 404, MAR SIKERES behozatal
// utan. Ezert a teszt nem a kod alakjat nezi, hanem VALODIBAN lefuttatja a
// hurkot egy fuggo valasszal.
describe('a kerdezo hurok nem futhat onmagara (404-verseny)', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  /** A VALODI _photosPoll + _photosStopPoll, hamis ora es hamis halozat mellett. */
  function pollHarness() {
    const calls: Array<(v: { ok: boolean; body: any }) => void> = []
    const events: string[] = []
    let tick: null | (() => void) = null
    const factory = new Function(
      'document', 'fetch', 't', 'showToast', 'setInterval', 'clearInterval',
      '_photosSetError', '_photosShowApiDisabled', '_photosShowNoPhotosAccount',
      '_photosRefresh', '_photosAccount', '_photosAccountsReady',
      `let _photosPollTimer = null
       let _photosPollGen = 0
       ${extractFn(app, '_photosAddedMsg')}
       ${extractFn(app, '_photosPoll')}
       ${extractFn(app, '_photosStopPoll')}
       return { poll: _photosPoll, stop: _photosStopPoll }`,
    )
    const api = factory(
      { getElementById: () => ({ hidden: false, disabled: false }) },
      () => new Promise((resolve) => {
        calls.push((v) => resolve({ ok: v.ok, json: async () => v.body }))
      }),
      (k: string) => k,
      (m: string) => events.push(`toast:${m}`),
      (fn: () => void) => { tick = fn; return 1 },
      () => { tick = null },
      (m: string) => { if (m) events.push(`error:${m}`) },
      () => { events.push('apidisabled'); return true },
      () => { events.push('nophotos'); return true },
      () => events.push('refresh'),
      'lackor2',
      { lackor2: true },
    )
    return { api, calls, events, fire: () => { if (tick) tick() } }
  }

  it('a sorszam a lapon is letezik, nem csak a tesztben', () => {
    expect(app, 'a korok sorszama modul-szintu allapot').toMatch(/let _photosPollGen = 0/)
  })

  it('amig egy kor fut, a kovetkezo NEM indul el', () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    expect(h.calls.length).toBe(1)
    h.fire(); h.fire(); h.fire()
    expect(h.calls.length, 'ez a tobbszoros keres okozta a 404-et').toBe(1)
  })

  it('a fuggo kor lezarasa utan indulhat a kovetkezo', async () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: false } })
    await flush()
    h.fire()
    expect(h.calls.length, 'a hurok nem allhat le attol, hogy egyszerre egy kor van').toBe(2)
  })

  it('a leallitas UTAN beeso valasz mar nem szol bele', async () => {
    // A mar elindult keresrol nem lehet lemondani. Ha a felhasznalo kozben a
    // "Megsem"-et nyomta (vagy a behozatal mar kesz), a kesobb erkezo valasz
    // nem irhat feluli a kepernyot -- kulonben hibat latna egy SIKERES
    // behozatal utan. Pont ezt latta a Boss.
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.api.stop()
    h.calls[0]({ ok: false, body: { code: 'session_gone', error: 'Picker API 404: ENTITY_NOT_FOUND' } })
    await flush()
    expect(h.events, 'elavult korbol nem jelenhet meg semmi').toEqual([])
  })

  it('ujrainditas utan a REGI kor valasza mar nem szol bele', async () => {
    // Eletszeru: a Boss megnyomja megegyszer a "Kepek hozzaadasa" gombot,
    // mielott az elozo kor valasza beerne. A regi valasz ekkor egy MASIK
    // session-rol szol -- ha beleszolna, hamis "kesz" allapotot mutatna.
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.api.poll('SESS-2', 5000)
    h.calls[0]({ ok: true, body: { done: true, saved: 9 } })
    await flush()
    expect(h.events, 'a regi kor nem jelenthet keszt').toEqual([])
  })

  it('a siker utan mar nem kerdez tovabb', async () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: true, selected: 3, saved: 3 } })
    await flush()
    expect(h.events[0]).toContain('photos.result.saved')
    expect(h.events[1]).toBe('refresh')
    h.fire(); h.fire()
    expect(h.calls.length, 'a kesz behozatal utan nincs tovabbi keres').toBe(1)
  })

  it('ha minden kep mar megvolt, akkor sem hallgat', async () => {
    // Ez a legfelrevezetobb eset: a felhasznalo kijelolt 5 kepet, de mind
    // megvolt. Nulla uj kep -> a regi uzenet ("0 kep behozva") ugy hangzana,
    // mintha elromlott volna valami. Meg kell mondani, hogy szandekos.
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: true, selected: 5, saved: 0, duplicates: 5, cleaned: 0 } })
    await flush()
    expect(h.events[0]).toContain('photos.result.nothing_new')
    expect(h.events[0]).toContain('photos.result.duplicates')
    expect(h.events[1]).toBe('refresh')
  })

  // Boss, 2026-08-16: "kijeloltem... valami 194 et... a vegen azt irta ki hogy
  // sikerlt. nem irt hibat. de. a fotokba nem jott le semmilyen foto."
  // Ez a PONTOS eset: minden kijelolt elem mar korabbrol megvolt. A regi
  // mondat ilyenkor "Nem valasztottal ki kepet"-et mondott -- vagyis a rendszer
  // sajat vaksagat a felhasznalo hibajanak allitotta be.
  it('a MAR MEGVOLT kepekrol is elszamol, es kiirja a kijelolt darabszamot', async () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: true, selected: 194, saved: 0, already: 194, duplicates: 0, failed: 0 } })
    await flush()
    expect(h.events[0], 'a kijelolt darabszam nelkul a mondat felrevezeto').toContain('photos.result.head')
    expect(h.events[0]).toContain('photos.result.already')
    expect(h.events[0], 'nem allithatja, hogy nem valasztott kepet').not.toContain('photos.added_none')
  })

  it('a csonka lista figyelmeztetest kap, nem "kesz"-t', async () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: true, selected: 100, saved: 100, partial: true } })
    await flush()
    expect(h.events[0]).toContain('photos.result.partial')
  })

  it('a sehova nem sorolhato maradek is kiirodik', async () => {
    // Ha az elszamolas nem jon ki (kijelolt > uj + megvolt + egyforma + hiba),
    // az MAGA a hiba -- pont az, ami 2026-08-16-ig nemaan elveszett.
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: true, body: { done: true, selected: 194, saved: 100, already: 0, duplicates: 0, failed: 0 } })
    await flush()
    expect(h.events[0]).toContain('photos.result.unaccounted')
  })

  it('a lejart valasztasra emberi mondat jon, nem a Google 404-e', async () => {
    const h = pollHarness()
    h.api.poll('SESS-1', 5000)
    h.fire()
    h.calls[0]({ ok: false, body: { code: 'session_gone', error: 'Picker API 404: {"error":{"code":404}}' } })
    await flush()
    expect(h.events).toEqual(['error:photos.session_gone'])
    expect(h.events.join(' ')).not.toContain('404')
  })
})

// Boss, 2026-08-16: "kijeloltem ugy ahogy kell. es a vegen azt irta ki hogy
// sikerlt... de a fotokba nem jott le semmilyen foto. 102 van a fotokban de
// kozben meg valami 194 et jeloltem ki... talan az hogy mind a 194 et jeloltem
// ki egyszerre?"  -- IGEN, pontosan az. A `mediaItems.list` egy lapon max 100
// elemet ad; a `nextPageToken`-t nem olvastuk, tehat a 100. FOLOTTI kijeloles
// soha nem letezett a rendszer szamara.
describe('a kijelolt elemek listaja VEGIG lapozodik', () => {
  const page = (ids: string[], next?: string) => ({
    mediaItems: ids.map((id) => ({ id })),
    ...(next ? { nextPageToken: next } : {}),
  })

  it('a masodik lapot is elkeri, es osszefuzi', async () => {
    const urls: string[] = []
    const r = await fetchPickedMediaItems('SESS', 'TOK', async (u) => {
      urls.push(u)
      return urls.length === 1 ? page(['a', 'b'], 'T2') : page(['c'])
    })
    expect(r.items.map((i: any) => i.id)).toEqual(['a', 'b', 'c'])
    expect(r.partial).toBe(false)
    expect(urls.length, 'ket lap, ket keres').toBe(2)
    expect(urls[0], 'az elso lapon nincs lapozo-token').not.toContain('pageToken=')
    expect(urls[1]).toContain('pageToken=T2')
  })

  it('194 kijelolt elem MIND lejon, nem csak az elso 100', async () => {
    const all = Array.from({ length: 194 }, (_, i) => `id-${i}`)
    let at = 0
    const r = await fetchPickedMediaItems('SESS', 'TOK', async () => {
      const slice = all.slice(at, at + 100)
      at += slice.length
      return page(slice, at < all.length ? `T${at}` : undefined)
    })
    expect(r.items.length, 'a 100 folotti kijeloles is szamit').toBe(194)
  })

  it('minden lap 100-as merettel megy ki', async () => {
    const urls: string[] = []
    await fetchPickedMediaItems('SESS', 'TOK', async (u) => { urls.push(u); return page(['a']) })
    expect(urls[0]).toContain('pageSize=100')
  })

  it('az ELSO lap hibaja valodi hiba -- nem nyeljuk le', async () => {
    // Lejart session, 403, kikapcsolt API: mind sajat, ember-olvashato uzenetet
    // kap a hivo oldalon. Ha itt csendben ures listat adnank, a felulet "nem
    // valasztottal ki kepet"-et mondana egy 403-ra.
    await expect(fetchPickedMediaItems('SESS', 'TOK', async () => {
      throw new Error('Picker API 403: forbidden')
    })).rejects.toThrow('403')
  })

  it('kesobbi lap hibajanal a MAR megkapott elemek megmaradnak, de szol rola', async () => {
    // A baseUrl 60 percig el: 100 lehozott kep + oszinte "nem jott vegig"
    // tobbet er, mint egy ures hibauzenet es nulla kep.
    let n = 0
    const r = await fetchPickedMediaItems('SESS', 'TOK', async () => {
      if (++n === 1) return page(['a', 'b'], 'T2')
      throw new Error('halozati baj')
    })
    expect(r.items.length).toBe(2)
    expect(r.partial, 'a csonka listat meg kell mondani').toBe(true)
  })

  it('onmagat ismetlo lapozo-token nem visz vegtelen hurokba', async () => {
    let n = 0
    const r = await fetchPickedMediaItems('SESS', 'TOK', async () => {
      n++
      return page([`x${n}`], 'MINDIG-UGYANAZ')
    })
    expect(r.partial).toBe(true)
    expect(n, 'a masodik azonos token utan megallunk').toBeLessThan(5)
  })
})

describe('a szerver egy session-t csak EGYSZER hoz be', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const okRun = () => Promise.resolve({ saved: 1, failed: 0, duplicates: 0, cleaned: 0, selected: 1, already: 0 })

  it('a masodik kerdezes ugyanazt a futast varja meg, nem indit ujat', async () => {
    // Ez a kliens-oldali vedelem parja. Ha megis ket keres esne be (mas ful,
    // ujratoltott lap), a masodik NEM tolthetja le ugyanazt megegyszer: az
    // index duplan kapna meg a kepet, es a ket futas versenyezne egymassal.
    clearPickerRuns()
    let started = 0
    const done = { saved: 2, failed: 0, duplicates: 0, cleaned: 0, selected: 2, already: 0 }
    const p = (async () => { started++; await flush(); return done })()
    rememberPickerRun('lackor2:SESS', p)
    expect(getPickerRun('lackor2:SESS')).toBe(p)
    expect(await getPickerRun('lackor2:SESS')!).toEqual(done)
    expect(started, 'a behozatal egyszer indult el').toBe(1)
  })

  it('elhasalt futast NEM oriz meg -- azt ujra lehet probalni', async () => {
    clearPickerRuns()
    rememberPickerRun('lackor2:SESS', Promise.reject(new Error('halozati baj')))
    await flush()
    expect(getPickerRun('lackor2:SESS'), 'egy atmeneti baj nem teheti veglegesse a kudarcot').toBeUndefined()
  })

  it('nem no a vegtelenbe (a szolgaltatas hetekig fut)', () => {
    clearPickerRuns()
    for (let i = 0; i < 60; i++) rememberPickerRun(`k${i}`, okRun())
    expect(getPickerRun('k0'), 'a legregebbi kiesik').toBeUndefined()
    expect(getPickerRun('k59'), 'a legutobbi megmarad').toBeDefined()
  })

  it('a lekerdezes eloszor a mar futo behozatalt nezi meg', () => {
    // A SORREND itt a lenyeg: a session a behozatal vegen elengedodik, tehat
    // ha eloszor a Google-t kerdeznenk, epp a 404-et kapnank vissza.
    const get = route.slice(route.indexOf("path === '/api/photos/session' && method === 'GET'"))
    expect(get.indexOf('getPickerRun(runKey)')).toBeGreaterThan(-1)
    expect(get.indexOf('getPickerRun(runKey)')).toBeLessThan(get.indexOf('getAccessToken(account)'))
    expect(get).toMatch(/rememberPickerRun\(runKey, run\)/)
  })
})

describe('"a valaszto ablak mar nincs meg" kulon eset', () => {
  const REAL = 'Picker API 404: {"error":{"code":404,"message":"The entity you requested does not '
    + 'exist.","status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",'
    + '"reason":"ENTITY_NOT_FOUND","domain":"photos.googleapis.com"}]}}'

  it('felismeri a valodi Google-uzenetet', () => {
    expect(pickerSessionGone(REAL)).toBe(true)
  })

  it('a masik harom hibafajtat nem huzza ide', () => {
    expect(pickerSessionGone('Picker API 403: {"error":{"message":"Request had insufficient '
      + 'authentication scopes."}}')).toBe(false)
    expect(pickerSessionGone('Picker API 400: {"error":{"message":"The user must have a Google '
      + 'Photos account to perform that action."}}')).toBe(false)
    expect(pickerSessionGone('')).toBe(false)
  })

  it('410-zel valaszol: ami itt volt, mar nincs', () => {
    expect(route).toMatch(/code: 'session_gone' \}, 410\)/)
  })

  it('a felulet emberi mondatot mutat ra', () => {
    expect(extractFn(app, '_photosPoll'))
      .toMatch(/data\.code === 'session_gone'[\s\S]{0,80}t\('photos\.session_gone'\)/)
  })
})

// Boss, 2026-08-15: "talan egy olyat beepithetnel hogy duplikatumokat ne
// toltson le. le se toltse. vagy ha letolti utana torolje ha teljesen egyforma.
// videobol is meg fotobol is."
//
// A merteket a BAJTOK adjak (SHA-256), nem a fajlnev es nem a meret -- ezert
// mukodik fotora es videora ugyanugy, kulon ag nelkul.
describe('egyforma kepek: egy peldany a lemezen', () => {
  const photo = (o: Partial<StoredPhoto>): StoredPhoto => ({
    id: 'x', account: 'lackor2', file: 'x.jpg', mimeType: 'image/jpeg', createdTime: '',
    width: 100, height: 100, isVideo: false, bytes: 1000, savedAt: '2026-08-15T10:00:00Z', ...o,
  })

  it('a lenyomat a tartalmat meri, nem a nevet', () => {
    expect(sha256Bytes(Buffer.from('ugyanaz'))).toBe(sha256Bytes(Buffer.from('ugyanaz')))
    expect(sha256Bytes(Buffer.from('ugyanaz'))).not.toBe(sha256Bytes(Buffer.from('mas')))
    expect(sha256Bytes(Buffer.from('ugyanaz'))).toHaveLength(64)
  })

  it('UGYANAZON a fiokon a masodik sor eltunik, a fajlja torlodik', () => {
    // Ket egyforma csempe ugyanott: ezt latja a felhasznalo duplikatumnak.
    const r = dedupeIndex([
      photo({ id: 'A', file: 'a.jpg', sha256: 'HASH1' }),
      photo({ id: 'B', file: 'b.jpg', sha256: 'HASH1' }),
    ])
    expect(r.keep.map((p) => p.id)).toEqual(['A'])
    expect(r.dropped).toBe(1)
    expect(r.removeFiles).toEqual([{ account: 'lackor2', file: 'b.jpg' }])
  })

  it('KET FIOKNAL a sor megmarad, de a bajtok csak egyszer', () => {
    // Tiz bekotott fioknal ugyanaz a csaladi kep ket helyen is szerepelhet.
    // Mindket fiok alatt latszania kell -- de a lemezen egy peldany legyen.
    const r = dedupeIndex([
      photo({ id: 'A', account: 'lackor2', file: 'a.jpg', sha256: 'HASH1' }),
      photo({ id: 'B', account: 'masik', file: 'b.jpg', sha256: 'HASH1' }),
    ])
    expect(r.keep.map((p) => p.id), 'egyik fiok kepe sem tunhet el').toEqual(['A', 'B'])
    expect(r.keep[1].file, 'a masodik sor az ELSO fajljara mutat').toBe('a.jpg')
    expect(photoFileOwner(r.keep[1])).toBe('lackor2')
    expect(r.removeFiles).toEqual([{ account: 'masik', file: 'b.jpg' }])
    expect(r.dropped).toBe(0)
  })

  it('videora ugyanaz a szabaly -- nincs kulon ag', () => {
    const r = dedupeIndex([
      photo({ id: 'A', file: 'a.mp4', mimeType: 'video/mp4', isVideo: true, sha256: 'V' }),
      photo({ id: 'B', file: 'b.mp4', mimeType: 'video/mp4', isVideo: true, sha256: 'V' }),
    ])
    expect(r.keep.map((p) => p.id)).toEqual(['A'])
    expect(r.removeFiles).toEqual([{ account: 'lackor2', file: 'b.mp4' }])
  })

  it('csak a TELJESEN egyformat vonja ossze', () => {
    // Sorozatfelvetel: azonos meret, azonos ido, mas tartalom. Ezek KULON kepek.
    const r = dedupeIndex([
      photo({ id: 'A', file: 'a.jpg', sha256: 'H1' }),
      photo({ id: 'B', file: 'b.jpg', sha256: 'H2' }),
    ])
    expect(r.keep).toHaveLength(2)
    expect(r.removeFiles).toEqual([])
  })

  it('lenyomat nelkuli REGI sorhoz nem nyul', () => {
    // Amirol nem tudjuk, egyforma-e, azt nem dobjuk ki. Inkabb maradjon ket
    // peldany, mint hogy egy kep elvesszen.
    const r = dedupeIndex([photo({ id: 'A', file: 'a.jpg' }), photo({ id: 'B', file: 'b.jpg' })])
    expect(r.keep).toHaveLength(2)
    expect(r.removeFiles).toEqual([])
    expect(r.dropped).toBe(0)
  })

  it('a mar kozos fajlt nem torli ki a masik alol', () => {
    // Ez a legveszelyesebb hiba lenne: a sor eldobasa mellett elvinni a fajlt,
    // amire egy MEGMARADO sor is mutat -- a masik fiok kepe tunne el.
    const r = dedupeIndex([
      photo({ id: 'A', account: 'lackor2', file: 'a.jpg', sha256: 'H' }),
      photo({ id: 'B', account: 'masik', file: 'a.jpg', fileAccount: 'lackor2', sha256: 'H' }),
      photo({ id: 'C', account: 'lackor2', file: 'c.jpg', sha256: 'H' }),
    ])
    expect(r.keep.map((p) => p.id)).toEqual(['A', 'B'])
    expect(r.removeFiles, 'az a.jpg-t hasznalja meg valaki').toEqual([{ account: 'lackor2', file: 'c.jpg' }])
  })

  it('a lemezfoglalas a kozos fajlt egyszer szamolja', () => {
    const list = [
      photo({ id: 'A', account: 'lackor2', file: 'a.jpg', bytes: 1000 }),
      photo({ id: 'B', account: 'masik', file: 'a.jpg', fileAccount: 'lackor2', bytes: 1000 }),
      photo({ id: 'C', account: 'lackor2', file: 'c.jpg', bytes: 500 }),
    ]
    expect(uniqueBytes(list), 'a kozos kep nem foglal ketszer helyet').toBe(1500)
  })

  it('a lehozas mindket agon a lenyomatot nezi', () => {
    // A szabaly: a lenyomat UTAN, de a kep VEGLEGES helyre kerulese ELOTT
    // dontunk -- igy masodik peldany sosem all be a kepek koze.
    //
    // 2026-08-15 ota a bajtok nem a memoriaban gyulnek, hanem egy rejtett
    // .part fajlba folynak (a memoria-kapu miatt, lasd lentebb). A garancia
    // ettol nem gyengult: a .part nev nem kep, es duplikatumnal torlodik --
    // a Fotok oldal soha nem lat ket egyforma peldanyt. Boss szabalya ezt
    // kifejezetten megengedi: "vagy ha letolti utana torolje ha teljesen
    // egyforma".
    const dl = route.slice(route.indexOf('async function downloadPickedNow'),
      route.indexOf('export async function tryHandlePhotosPicker'))
    const hashAt = dl.indexOf('const hash = got.hash')
    const placeAt = dl.indexOf('renameSync(partPath, join(dir, file))')
    expect(hashAt, 'nincs lenyomat a letoltesben').toBeGreaterThan(-1)
    expect(placeAt, 'nincs vegleges elhelyezes').toBeGreaterThan(-1)
    expect(hashAt, 'eloszor lenyomat, csak utana a vegleges nev').toBeLessThan(placeAt)
    expect(dl.indexOf('const twin = byHash.get(hash)'),
      'a dontes is megelozi az elhelyezest').toBeLessThan(placeAt)
    // A vegleges nevre EGYETLEN uton lehet kikerulni: a .part atnevezesevel.
    // Egy odacsempeszett writeFileSync ugyanugy masodik peldanyt csinalna.
    expect(dl, 'a kepbajtok csak atnevezessel kerulhetnek a helyukre')
      .not.toMatch(/writeFileSync\(/)
    // ...es a talalat utan NEM helyez el semmit: a folytatas a kovetkezo elem.
    expect(dl).toMatch(/if \(twin\) \{[\s\S]*?duplicates\+\+[\s\S]*?continue\n/)
    expect(dl, 'duplikatumnal a letoltott darab torlodik')
      .toMatch(/if \(twin\) \{\s*\n\s*rmSync\(partPath, \{ force: true \}\)/)
  })

  it('a regi allomanyt is rendbe teszi, mielott hozzatesz', () => {
    // "vagy ha letolti utana torolje ha teljesen egyforma" -- a mar lementett
    // duplikatumok is kitakarodnak, nem csak a mostaniak maradnak ki.
    const dl = route.slice(route.indexOf('async function downloadPickedNow'))
    expect(dl).toMatch(/backfillHashes\(index\)/)
    expect(dl).toMatch(/applyDedupe\(index\)/)
    expect(dl.indexOf('applyDedupe(index)')).toBeLessThan(dl.indexOf('for (const raw of items)'))
    expect(dl, 'a takaritas eredmenye is mentodik').toMatch(/if \(filled \|\| cleanup\.dropped\) saveIndex\(index\)/)
  })

  it('a regi allomany lenyomatolasa nem allitja meg az egesz dashboardot', () => {
    // Az ELSO futas a teljes addigi allomanyon vegigmegy (a mereskor 6,5 GB,
    // benne tobb szaz MB-os videokkal). Egyben beolvasva a dashboard egyetlen
    // szala percekre megallna: se Email, se Drive, se Telegram kozben.
    // Csak a TORZS, a magyarazo megjegyzes nelkul (az emliti a readFileSync-et).
    const fnStart = route.indexOf('export async function backfillHashes')
    const fn = route.slice(fnStart, route.indexOf('\n}', fnStart))
    expect(fn, 'nem olvassa be egyben a fajlt').not.toMatch(/readFileSync/)
    expect(fn).toMatch(/await sha256File\(f\)/)
    const sfStart = route.indexOf('function sha256File(file')
    const streamFn = route.slice(sfStart, route.indexOf('\n}', sfStart))
    expect(streamFn, 'darabokban olvas').toContain('createReadStream(file)')
    expect(streamFn, 'darabonkent adja hozza').toMatch(/on\('data', \(chunk\) => h\.update\(chunk\)\)/)
    expect(streamFn, 'itt sem olvashat egyben').not.toMatch(/readFileSync/)
    expect(route).toMatch(/const filled = await backfillHashes\(index\)/)
  })

  it('a darabolt lenyomat ugyanaz, mint az egyben szamolt', async () => {
    // Valodi meres: ha a darabolas elrontana a lenyomatot, minden regi kep
    // "ujnak" latszana, es a duplikatum-szures nema modon leallna.
    const acc = 'vitesthash'
    const dir = join(PROJECT_ROOT, 'store', 'photos', acc)
    const buf = Buffer.alloc(200_000)
    for (let i = 0; i < buf.length; i++) buf[i] = i % 251  // tobb olvasasi darab
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'a.jpg'), buf)
      const list = [
        photo({ id: 'H1', account: acc, file: 'a.jpg' }),
        photo({ id: 'H2', account: acc, file: 'nincs-ilyen.jpg' }),
      ]
      expect(await backfillHashes(list)).toBe(1)
      expect(list[0].sha256).toBe(sha256Bytes(buf))
      // A hianyzo fajl nem esik ki az indexbol, csak lenyomat nelkul marad.
      expect(list[1].sha256).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ket fiok letoltese nem fut egymasba (kulonben az index elveszne)', async () => {
    // Az index egyetlen kozos JSON: parhuzamos futasnal a masodik mentes a
    // sajat, elavult masolatat irna vissza -- az elso fiok kepei eltunnenek
    // belole, mikozben a fajlok ott allnak a lemezen.
    const order: string[] = []
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const a = queuePhotoDownload(async () => { order.push('a-start'); await wait(20); order.push('a-end'); return 'a' })
    const b = queuePhotoDownload(async () => { order.push('b-start'); await wait(1); order.push('b-end'); return 'b' })
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('egy elhasalt letoltes nem allitja meg a sort', async () => {
    await expect(queuePhotoDownload(async () => { throw new Error('halozat') })).rejects.toThrow('halozat')
    await expect(queuePhotoDownload(async () => 'ok')).resolves.toBe('ok')
  })

  it('a letoltes tenylegesen a soron megy keresztul', () => {
    expect(route).toMatch(/function downloadPicked\([^)]*\): Promise<DownloadResult> \{\n\s*return queuePhotoDownload\(\(\) => downloadPickedNow\(/)
  })

  it('egy fiokbol torles nem viszi el a masik fiok kepet', () => {
    const rm = route.slice(route.indexOf("path === '/api/photos/remove'"))
    expect(rm).toMatch(/const stillUsed = rest\.some\(/)
    expect(rm).toMatch(/if \(!stillUsed\) \{/)
  })

  it('a kep kiadasa a VALODI gazda konyvtarabol megy', () => {
    // CSAK a /media agat nezzuk: a fajl vegeig vagva a lentebbi /remove ag
    // helyes sora is "igazolna" egy elrontott /media-t (szabotazs-proba 17.).
    const start = route.indexOf("path === '/api/photos/media'")
    const media = route.slice(start, route.indexOf("if (path === '/api/photos/", start + 10))
    expect(media, 'a vagas nem nyulhat at a kovetkezo agba').not.toMatch(/photos\/remove/)
    // A gazda szerint, es a fajl helyet a LEMEZ donti el (depo vagy regi hely).
    expect(media).toMatch(/photoFilePath\(photoFileOwner\(entry\), entry\.file\)/)
    // A bolyegkep oda kerul, ahol maga a kep van -- kulonben egy koltozes utan
    // a bolyegek a regi mappaban maradnanak arvan.
    expect(media).toMatch(/const ownerDir = dirname\(file\)/)
  })

  it('a felhasznalo megtudja, mi tortent -- a duplikatum nem nema', () => {
    const msg = extractFn(app, '_photosAddedMsg')
    // Az uzenet OSSZERAKOTT, nem elore gyartott mondat. A regi terv minden
    // kombinaciora sajat kulcsot tartott (`added_with_dup`, `added_only_dup`),
    // ami ot szamnal kombinatorikusan robban -- es epp a ritka egyuttallasoknal
    // maradt volna nema. Most minden szam sajat darabot ad, es a darabok
    // osszefuzodnek; a duplikatum ezek kozott ott van.
    expect(msg).toMatch(/photos\.result\.duplicates/)
    expect(msg).toMatch(/photos\.result\.saved/)
    expect(msg).toMatch(/photos\.result\.already/)
    expect(msg).toMatch(/photos\.result\.failed/)
    expect(msg).toMatch(/photos\.cleaned/)
    // A maradek-ag a nemasag elleni utolso zar: ha a szamok nem jonnek ki,
    // AZT IS kimondja, nem hallgatja el a kulonbseget.
    expect(msg).toMatch(/photos\.result\.unaccounted/)
    expect(extractFn(app, '_photosPoll')).toMatch(/showToast\(_photosAddedMsg\(data\)\)/)
  })
})

// Boss, 2026-08-15: "a fotoknal amikor frissitek mindig a lackor2 re valt.
// maradjon azon ahol eppen vagyok. ha usalackor akor azon maradjon."
//
// Lapfrissiteskor a modul-szintu _photosAccount elveszik, es a lap az elso
// HASZNALHATO fiokra ugrott -- az pedig ABC-ben a lackor2. Tiz bekotott fioknal
// ez minden F5 utan ujra-kattintas. A teszt a VALODI loadPhotosPage-et futtatja.
describe('a kivalasztott fiok tullep a lapfrissitesen', () => {
  function pageHarness(opts: { accounts: Array<{ name: string; ready: boolean }>; saved?: string; blocked?: boolean }) {
    const store: Record<string, string> = {}
    if (opts.saved !== undefined) store['marveen.account.photos'] = opts.saved
    const select: any = { innerHTML: '', value: '', onchange: null }
    const ls = {
      getItem: (k: string) => { if (opts.blocked) throw new Error('tiltott tarolo'); return store[k] ?? null },
      setItem: (k: string, v: string) => { if (opts.blocked) throw new Error('tiltott tarolo'); store[k] = v },
    }
    const factory = new Function(
      'document', 'fetch', 'localStorage', '_photosReleaseBlobs', '_photosSetError',
      't', 'escapeHtml', '_photosRefresh',
      `let _photosAccount = ''
       let _photosAccountsReady = {}
       ${extractFn(app, '_rememberAccount')}
       ${extractFn(app, '_recallAccount')}
       ${extractFn(app, 'loadPhotosPage')}
       return { load: loadPhotosPage, acc: () => _photosAccount }`,
    )
    const api = factory(
      { getElementById: (id: string) => (id === 'photosAccountSelect' ? select : { textContent: '', hidden: false }) },
      async () => ({ ok: true, json: async () => ({ accounts: opts.accounts, default: opts.accounts[0]?.name }) }),
      ls,
      () => { }, () => { }, (k: string) => k, (s: string) => s, async () => { },
    )
    return { api, select, store }
  }
  const TWO = [{ name: 'lackor2', ready: true }, { name: 'usalackor', ready: true }]

  it('a legutobb valasztott fiokon marad, nem ugrik vissza a lackor2-re', async () => {
    const h = pageHarness({ accounts: TWO, saved: 'usalackor' })
    await h.api.load()
    expect(h.api.acc(), 'ez volt a Boss panasza').toBe('usalackor')
    expect(h.select.innerHTML).toMatch(/value="usalackor" selected/)
  })

  it('a valtast azonnal megjegyzi -- nem csak a kepernyon valt', async () => {
    const h = pageHarness({ accounts: TWO })
    await h.api.load()
    expect(h.api.acc()).toBe('lackor2')
    h.select.value = 'usalackor'
    h.select.onchange()
    expect(h.store['marveen.account.photos']).toBe('usalackor')
  })

  it('ha nincs meg valasztas, marad a regi szabaly: elso HASZNALHATO fiok', async () => {
    const h = pageHarness({ accounts: [{ name: 'lackor2', ready: false }, { name: 'usalackor', ready: true }] })
    await h.api.load()
    expect(h.api.acc(), 'ne a "nincs engedely" doboz fogadja').toBe('usalackor')
  })

  it('idokozben eltavolitott fiokra nem ragad be', async () => {
    // Ha a megjegyzett fiokot kikotottek, a lap nem allhat le, es nem is
    // kerdezhet egy mar nem letezo fiokot.
    const h = pageHarness({ accounts: TWO, saved: 'mar-nincs-ilyen' })
    await h.api.load()
    expect(h.api.acc()).toBe('lackor2')
  })

  it('tiltott tarolonal (privat mod) is mukodik a lap', async () => {
    // A localStorage nem mindig irhato. Ez kenyelmi funkcio -- nem allithatja
    // meg tole a Fotok oldal.
    const h = pageHarness({ accounts: TWO, blocked: true })
    await h.api.load()
    expect(h.api.acc()).toBe('lackor2')
    h.select.value = 'usalackor'
    expect(() => h.select.onchange()).not.toThrow()
  })

  it('a Drive ugyanezt a megjegyzest hasznalja, sajat kulccsal', () => {
    // Ugyanaz a bosszusag ott is megvolt; a kulcs viszont lapokent kulon, mert
    // a Drive-on mas fiokot nezhet az ember, mint a Fotokban.
    const drive = extractFn(app, 'loadDrivePage')
    expect(drive).toMatch(/_recallAccount\('drive'\)/)
    expect(app).toMatch(/_rememberAccount\('drive', _driveAccount\)/)
    expect(extractFn(app, 'loadPhotosPage')).toMatch(/_recallAccount\('photos'\)/)
  })
})

describe('nyelvi kulcsok', () => {
  const KEYS = ['nav.photos', 'photos.page_title', 'photos.page_subtitle', 'photos.add_btn',
    'photos.empty_msg', 'photos.empty_hint', 'photos.no_account', 'photos.account_no_scope',
    'photos.load_error', 'photos.loading', 'photos.usage', 'photos.consent_title',
    'photos.consent_lead', 'photos.consent_start', 'photos.consent_step1', 'photos.consent_step2',
    'photos.consent_step3', 'photos.consent_exchanging', 'photos.consent_done',
    'photos.apidisabled_title', 'photos.apidisabled_lead', 'photos.apidisabled_step1',
    'photos.apidisabled_open', 'photos.apidisabled_step2', 'photos.apidisabled_step3',
    'photos.apidisabled_retry', 'photos.apidisabled_project',
    'photos.nophotos_title', 'photos.nophotos_lead', 'photos.nophotos_step1',
    'photos.nophotos_open', 'photos.nophotos_step2', 'photos.nophotos_step3',
    'photos.nophotos_step4', 'photos.nophotos_retry', 'photos.nophotos_account',
    'photos.session_gone',
    'photos.waiting_msg', 'photos.waiting_hint',
    'photos.cancel_btn', 'photos.session_failed', 'photos.popup_blocked',
    'photos.added_none', 'photos.remove_btn', 'photos.remove_confirm', 'photos.remove_done',
    'photos.remove_failed', 'photos.close_btn', 'photos.cleaned',
    'photos.result.head', 'photos.result.saved', 'photos.result.nothing_new',
    'photos.result.already', 'photos.result.duplicates', 'photos.result.failed',
    'photos.result.unaccounted', 'photos.result.partial']

  it('mind a ket nyelvben megvan az osszes kulcs', () => {
    for (const k of KEYS) {
      expect(hu.includes(`'${k}'`), `hu.js: ${k}`).toBe(true)
      expect(en.includes(`'${k}'`), `en.js: ${k}`).toBe(true)
    }
  })

  it('a behelyettesitett ertekek mindket nyelvben ugyanazok', () => {
    for (const [lang, src] of [['hu', hu], ['en', en]] as const) {
      expect(new RegExp(`'photos\\.usage':[^\\n]*\\{count\\}`).test(src), `${lang} count`).toBe(true)
      expect(new RegExp(`'photos\\.usage':[^\\n]*\\{size\\}`).test(src), `${lang} size`).toBe(true)
      // A kijelolt darabszam a fejlecben van -- e nelkul a mondat megint el
      // tudna hallgatni, hogy 194 kijeloltbol lett nulla (2026-08-16).
      expect(new RegExp(`'photos\\.result\\.head':[^\\n]*\\{selected\\}`).test(src), `${lang} head`).toBe(true)
      for (const k of ['saved', 'already', 'duplicates', 'failed', 'unaccounted']) {
        expect(new RegExp(`'photos\\.result\\.${k}':[^\\n]*\\{count\\}`).test(src), `${lang} ${k}`).toBe(true)
      }
      expect(new RegExp(`'photos\\.cleaned':[^\\n]*\\{count\\}`).test(src), `${lang} cleaned`).toBe(true)
    }
  })
})

// A memoria-kapu 2026-08-15-en HARD PAUSE-t hirdetett (89% hasznalt, 827 MB
// szabad) es leparkolt egy tetlen agenst. Az ok a fotok letoltese volt: minden
// fajl EGYBEN keszult a memoriaba. Boss: "keslelteted kicsit a fotok
// feltolteset vagy valami ... de ne alljon le ez lenne a lenyeg".
describe('a letoltes nem eszi meg a memoriat', () => {
  const TMP = join(PROJECT_ROOT, 'store', 'photos', 'vitest-stream')

  const bodyOf = (buf: Buffer, chunk = 64 * 1024) => new ReadableStream({
    start(c) {
      for (let i = 0; i < buf.length; i += chunk) c.enqueue(new Uint8Array(buf.subarray(i, i + chunk)))
      c.close()
    },
  })

  it('a fajl SOHA nem kerul egyben a memoriaba (nincs arrayBuffer a letoltesben)', () => {
    // A megjegyzesek KI vannak zarva: a modul fejleceben szandekosan ott all,
    // MI volt a hiba (Buffer.from(await r.arrayBuffer())) -- a magyarazat nem
    // buktathatja meg a sajat ellenorzeset. A KOD viszont sehol nem teheti.
    const code = route.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code, 'valahol megis egyben olvassa be a valaszt').not.toMatch(/arrayBuffer\(\)/)
    expect(route).toContain('await pipeline(Readable.fromWeb(body as any), hasher, createWriteStream(dest))')
  })

  it('a darabolt letoltes ugyanazt a lenyomatot adja, mint az egyben szamolt', async () => {
    // 3 MB alairassal: tobb darabon at kell azonos eredmenyt adnia, kulonben a
    // duplikatum-szures csendben elromlana.
    mkdirSync(TMP, { recursive: true })
    const buf = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + 7) % 251
    const dest = join(TMP, 'a.bin')
    try {
      const got = await streamToFile(bodyOf(buf), dest)
      expect(got.hash).toBe(sha256Bytes(buf))
      expect(got.bytes).toBe(buf.length)
      // ...es a lemezre is pontosan ugyanaz kerult ki.
      expect(sha256Bytes(readFileSync(dest))).toBe(got.hash)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('az elso darabok sem veszhetnek el (a lenyomat atereszto fokozat, nem data-figyelo)', async () => {
    // Egy sajat 'data' figyelo folyo modba kapcsolna a forrast, mielott a
    // pipeline rakot a celra. Merve: a hash es a hossz egy 200 darabos folyamnal
    // is pontos kell legyen.
    mkdirSync(TMP, { recursive: true })
    const buf = Buffer.from('x'.repeat(200 * 1000))
    const dest = join(TMP, 'b.bin')
    try {
      const got = await streamToFile(bodyOf(buf, 1000), dest)
      expect(got.bytes).toBe(buf.length)
      expect(got.hash).toBe(sha256Bytes(buf))
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('ures valasz-torzsnel hibat dob (nem ir ki nulla bajtos kepet)', async () => {
    await expect(streamToFile(null, join(TMP, 'c.bin'))).rejects.toThrow()
  })

  it('a bajtok eloszor .part fajlba mennek, es csak keszen kapjak a vegleges nevet', () => {
    expect(route).toContain('const partPath = join(dir, `.${file}.part`)')
    expect(route).toContain('renameSync(partPath, join(dir, file))')
    // Duplikatum: a bajtokat eldobjuk, a vegleges nevet meg sem kapja.
    expect(route).toMatch(/if \(twin\) \{\s*\n\s*rmSync\(partPath, \{ force: true \}\)/)
    // Elhasalt letoltes: a felbeszakadt darab sem maradhat ott.
    const catchAt = route.indexOf('[photos] egy kep nem jott le')
    expect(route.slice(catchAt - 300, catchAt)).toContain('rmSync(partPath, { force: true })')
  })

  it('szoros memorianal var, de a vegen MINDIG tovabbmegy', async () => {
    // "de ne alljon le ez lenne a lenyeg": ha a memoria tartosan keves, a
    // varakozas a felso korlatnal veget er es a kep akkor is lejon. Kulonben a
    // 60 percig elo baseUrl lejarna, es a valasztas veszne el.
    const prev = { ...process.env }
    process.env.MARVEEN_PHOTO_PAUSE_MS = '0'
    process.env.MARVEEN_PHOTO_MIN_AVAIL_MB = '999999'
    process.env.MARVEEN_PHOTO_MAX_WAIT_MS = '40'
    try {
      const t0 = Date.now()
      const waited = await breathe(() => 1)        // "mindig keves a memoria"
      const spent = Date.now() - t0
      expect(waited).toBe(40)
      expect(spent, 'nem allhat meg orokre').toBeLessThan(2000)
    } finally {
      process.env = prev
    }
  })

  it('ha van eleg memoria, nem varakozik feleslegesen', async () => {
    const prev = { ...process.env }
    process.env.MARVEEN_PHOTO_PAUSE_MS = '0'
    process.env.MARVEEN_PHOTO_MIN_AVAIL_MB = '100'
    try {
      expect(await breathe(() => 5000)).toBe(0)
    } finally {
      process.env = prev
    }
  })

  it('a fekezes kikapcsolhato, es a rossz ertek nem fagyaszt be semmit', async () => {
    const prev = { ...process.env }
    try {
      process.env.MARVEEN_PHOTO_PAUSE_MS = '0'
      process.env.MARVEEN_PHOTO_MIN_AVAIL_MB = '0'
      expect(await breathe(() => 0), 'a 0 kuszob = kikapcsolt varakozas').toBe(0)
      // Elgepelt ertek nem valhat NaN-na: a NaN minden osszehasonlitasban hamis,
      // azaz a fek csendben kikapcsolna.
      process.env.MARVEEN_PHOTO_MIN_AVAIL_MB = 'ezer'
      process.env.MARVEEN_PHOTO_PAUSE_MS = '-5'
      const cfg = photoThrottleConfig()
      expect(cfg.minAvailMb).toBe(1200)
      expect(cfg.pauseMs).toBe(120)
      expect(Number.isFinite(cfg.maxWaitMs)).toBe(true)
    } finally {
      process.env = prev
    }
  })

  it('ismeretlen kornyezetben NEM fekez (a 0 minden kepnel kivarast jelentene)', () => {
    // Ha a /proc nem olvashato es 0-t adnank vissza, a fek minden kepnel a
    // teljes felso korlatot kivarna: 30 masodperc kepenkent, csendben.
    expect(availableMemMb('/nincs/ilyen/fajl')).toBe(Number.POSITIVE_INFINITY)
    // Ismeretlen formatum ugyanigy: nem talalgatunk.
    mkdirSync(TMP, { recursive: true })
    const junk = join(TMP, 'meminfo')
    writeFileSync(junk, 'ez nem meminfo\nMemTotal: valami\n')
    try {
      expect(availableMemMb(junk)).toBe(Number.POSITIVE_INFINITY)
      // A valodi olvasas viszont ertelmes szamot ad (Linuxon; mashol Infinity).
      const real = availableMemMb()
      expect(real > 0, 'a valodi ertek nem lehet 0').toBe(true)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('a szoros-memoria varakozas a valodi meressel is korlatos', async () => {
    // A fenti tesztek beinjektalt ertekkel merik a fekezest; ez az alapertelmezett
    // uton (valodi memoria-olvasas) ellenorzi, hogy a hivas visszater.
    const prev = { ...process.env }
    process.env.MARVEEN_PHOTO_PAUSE_MS = '0'
    process.env.MARVEEN_PHOTO_MIN_AVAIL_MB = '0'
    try {
      expect(await breathe()).toBe(0)
    } finally {
      process.env = prev
    }
  })

  it('a kilott folyamat utan ottmaradt darabokat kitakaritja', () => {
    // A hibaag csak a KEZELT hibak utan takarit. Ha a szolgaltatast letoltes
    // kozben inditjak ujra, az soha nem fut le -- a darab ott ulne a vegtelensegig.
    mkdirSync(TMP, { recursive: true })
    try {
      writeFileSync(join(TMP, '.abc.jpg.part'), 'felig lejott')
      writeFileSync(join(TMP, '.def.mp4.part'), 'ez is')
      writeFileSync(join(TMP, 'kesz.jpg'), 'ez marad')
      writeFileSync(join(TMP, '.index.json'), 'ez is marad')  // rejtett, de nem .part
      expect(sweepPartFiles(TMP)).toBe(2)
      expect(existsSync(join(TMP, '.abc.jpg.part'))).toBe(false)
      expect(existsSync(join(TMP, '.def.mp4.part')), 'a videok darabja is').toBe(false)
      expect(existsSync(join(TMP, 'kesz.jpg')), 'kesz kepet SOHA nem dobhat el').toBe(true)
      expect(existsSync(join(TMP, '.index.json')), 'csak a .part a celpont').toBe(true)
      // Masodszorra mar nincs mit takaritani -- es nem is hasal el rajta.
      expect(sweepPartFiles(TMP)).toBe(0)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('a takaritas nem all meg nemletezo mappan', () => {
    expect(sweepPartFiles(join(TMP, 'nincs-ilyen'))).toBe(0)
  })

  it('arva = a lemezen van, de egyetlen sor sem hivatkozik ra', () => {
    const keep = new Set(['a.jpg', 'b.mp4'])
    const got = orphanFiles(['a.jpg', 'b.mp4', 'regi.jpg', 'index.json', '.rejtett.part'], keep)
    expect(got).toEqual(['regi.jpg'])
    // Az index es a rejtett fajlok soha nem arvak: azokat mas kezeli.
    expect(got).not.toContain('index.json')
    expect(got).not.toContain('.rejtett.part')
  })

  it('a gazdatlan fajlokat eldobja, a hivatkozottakat SOHA', () => {
    // Meres az eles allomanyon (2026-08-15): 389 fajl / 378 index-sor. A 11
    // kulonbseg a regi mechanizmus maradeka -- a Fotok oldalon sosem latszott.
    mkdirSync(TMP, { recursive: true })
    try {
      for (const f of ['a.jpg', 'b.mp4', 'regi.jpg']) writeFileSync(join(TMP, f), f)
      expect(sweepOrphanFiles(TMP, new Set(['a.jpg', 'b.mp4']), false)).toBe(1)
      expect(existsSync(join(TMP, 'regi.jpg'))).toBe(false)
      expect(existsSync(join(TMP, 'a.jpg')), 'hivatkozott fajl nem eshet aldozatul').toBe(true)
      expect(existsSync(join(TMP, 'b.mp4'))).toBe(true)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('SERULT vagy URES index eseten egyetlen kepet sem torol', () => {
    // A loadIndex() serult fajlnal szandekosan ures listat ad. Ha erre
    // takaritanank, a Boss OSSZES lementett kepet kitorolnenk egy csapasra.
    //
    // A meres KULON fogja meg a ket korlatot. Eloszor csak az "ures index"
    // korlatot: a `keep` szandekosan NEM ures (es akkora, hogy a "tul sok arva"
    // fek se lepjen kozbe) -- igy ha az elso korlat kiesne, a b.jpg tenylegesen
    // eltunne. Egy korabbi valtozatban ez a ket korlat egyetlen sorban allt, es
    // a szabotazs-proba (25. eset) atment: a masik fek fogta meg helyette, en
    // pedig azt hittem volna, hogy ezt merem.
    mkdirSync(TMP, { recursive: true })
    try {
      for (const f of ['a.jpg', 'b.jpg']) writeFileSync(join(TMP, f), f)
      expect(sweepOrphanFiles(TMP, new Set(['a.jpg']), true), 'ures index').toBe(0)
      expect(existsSync(join(TMP, 'b.jpg')), 'ures indexnel semmit nem torlunk').toBe(true)
      // ...aztan a masodik korlat: ehhez a fiokhoz egyetlen elo sor sincs.
      expect(sweepOrphanFiles(TMP, new Set(), false), 'nincs elo sor ehhez a fiokhoz').toBe(0)
      expect(existsSync(join(TMP, 'a.jpg'))).toBe(true)
      expect(existsSync(join(TMP, 'b.jpg'))).toBe(true)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('gyanusan sok arvanal inkabb nem nyul semmihez', () => {
    // Elcsuszott mappanev vagy felig visszaallitott index eseten a "takaritas"
    // adatvesztes lenne. A megallas dragabb, mint a felesleges MB.
    mkdirSync(TMP, { recursive: true })
    try {
      for (const f of ['a.jpg', 'x1.jpg', 'x2.jpg', 'x3.jpg']) writeFileSync(join(TMP, f), f)
      expect(sweepOrphanFiles(TMP, new Set(['a.jpg']), false)).toBe(0)
      for (const f of ['x1.jpg', 'x2.jpg', 'x3.jpg']) {
        expect(existsSync(join(TMP, f)), `${f} megmarad`).toBe(true)
      }
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('a megosztott peldany nem tunik el a masik fiok mappajabol', () => {
    // Ket fioknal ugyanaz a kep: EGY fajl a gazda mappajaban, a masik fiok sora
    // ra hivatkozik. A megtartando nevek a fajl GAZDAJA szerint gyulnek.
    expect(route).toContain('ownerDirOf(photoFileOwner(p)) === dir')
    const at = route.indexOf('sweepOrphanFiles(dir, keep')
    expect(at, 'nincs is gazdatlan-takaritas').toBeGreaterThan(0)
    // ...es csak azutan, hogy az index rendbe lett teve (lenyomatok + egyformak).
    expect(at).toBeGreaterThan(route.indexOf('const cleanup = applyDedupe(index)'))
  })

  it('a takaritas a letoltes ELEJEN fut, meg a kepek elott', () => {
    const at = route.indexOf('sweepPartFiles(dir)')
    expect(at, 'nincs is takaritas').toBeGreaterThan(0)
    expect(at, 'a kepek ciklusa elott kell lennie')
      .toBeLessThan(route.indexOf('for (const raw of items)'))
  })

  it('minden kep elott levegot vesz (nem csak a futas elejen egyszer)', () => {
    const at = route.indexOf('await breathe()')
    expect(at, 'nincs is levegovetel').toBeGreaterThan(0)
    // A hivas a kepenkenti cikluson BELUL van: a ciklus feje elotte kezdodik.
    const loopAt = route.indexOf('for (const raw of items)')
    expect(loopAt).toBeGreaterThan(0)
    expect(at).toBeGreaterThan(loopAt)
  })
})

// ===========================================================================
// Bolyegkepek
//
// Boss, 2026-08-15: "nem lehet hogy amikor a fotok ilyen kicsibe megjelennek
// akkor kisebb meretet foglaljanak? csak ha megnyitom nagyba akkor hasznalja a
// teljes minoseget?"
//
// A mert tet (sajat tar, 2026-08-15): 342 kep = 110 MB, de 36 VIDEO = 6985 MB,
// koztuk egy 1807 MB-os. A racs eddig mindent teljes meretben lehozott -- egy
// vegiggorgetes 7 GB-ot mozgatott a gepen belul.
// ===========================================================================
describe('bolyegkepek: a racs ne hozza le a teljes fajlt', () => {
  const TMP = join(PROJECT_ROOT, 'store', 'photos', 'vitest-thumb')

  async function ffmpeg(args: string[]): Promise<void> {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args])
  }

  it('a bolyeg neve a TARTALOM lenyomatabol jon (ket egyformanak egy bolyege van)', () => {
    expect(thumbFileName({ sha256: 'abc123', file: 'barmi.jpg' })).toBe('abc123.jpg')
    expect(thumbFileName({ sha256: 'abc123', file: 'masik.jpg' }))
      .toBe(thumbFileName({ sha256: 'abc123', file: 'barmi.jpg' }))
  })

  it('lenyomat nelkuli regi sornal a fajlnev a tartalek -- utvonal nelkul', () => {
    expect(thumbFileName({ file: 'kep.jpg' })).toBe('kep.jpg.jpg')
    // Konyvtar-kiugras nem irhat ki a mappabol.
    const kiugro = thumbFileName({ file: '../../titok' })
    expect(kiugro).not.toContain('/')
    expect(kiugro).not.toContain('\\')
  })

  it('a scale szuro IDEZOJELES -- kulonben shell nelkul szethullik', () => {
    // Merve: idezojel nelkul az ffmpeg "No such filter: 'iw):-2'"-vel elszall,
    // mert a min(480,iw) vesszoje szurolancot valasztana el.
    const args = thumbArgs('be.jpg', 'ki.jpg', false, 1)
    const vf = args[args.indexOf('-vf') + 1]
    expect(vf).toBe(`scale='min(${THUMB_WIDTH},iw)':-2`)
  })

  it('a formatumot KIMONDJA -- a .tmp veg miatt nem talalna ki', () => {
    // Merve: `-f image2` nelkul az ffmpeg a `.jpg.tmp` nevre azt mondja,
    // "Unable to choose an output format", es EGYETLEN bolyeg sem keszul el.
    const args = thumbArgs('be.jpg', 'ki.jpg.tmp', false, 1)
    expect(args[args.indexOf('-f') + 1]).toBe('image2')
  })

  it('kepnel NINCS tekeres, videonal VAN -- es a tekeres a bemenet ELOTT all', () => {
    const kep = thumbArgs('be.jpg', 'ki.jpg', false, 1)
    expect(kep).not.toContain('-ss')
    const vid = thumbArgs('be.mp4', 'ki.jpg', true, 1)
    // A gyors tekereshez az -ss-nek a bemenet ELOTT kell allnia: igy nem
    // olvassa vegig a fajlt (merve: 1,8 GB-os videon 0,15 mp).
    expect(vid.indexOf('-ss')).toBeLessThan(vid.indexOf('-i'))
    expect(vid[vid.indexOf('-ss') + 1]).toBe('1')
    // 0 masodperces tekeresnel viszont ne tegyen ki felesleges -ss-t.
    expect(thumbArgs('be.mp4', 'ki.jpg', true, 0)).not.toContain('-ss')
  })

  it('valodi kepbol valodi, KISEBB bolyeg lesz', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const { statSync } = await import('node:fs')
      const src = join(TMP, 'nagy.jpg')
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=1600x1200', '-frames:v', '1', src, '-y'])
      const eredeti = statSync(src).size

      const out = await ensureThumb(src, TMP, { sha256: 'proba', file: 'nagy.jpg', isVideo: false })
      expect(out, 'nem keszult bolyegkep').toBeTruthy()
      expect(existsSync(out!)).toBe(true)
      expect(statSync(out!).size).toBeLessThan(eredeti)
      // A rejtett mappaba kerul: a takarito seprusok igy nem nyulnak hozza.
      expect(out!).toContain(THUMB_DIRNAME)
      expect(THUMB_DIRNAME.startsWith('.'), 'kulonben az arva-takarito letorolne').toBe(true)
      // ...es tenyleg kisebb a KEP is, nem csak a fajl.
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error',
        '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', out!])
      expect(Number(stdout.trim().replace(/\D/g, ''))).toBe(THUMB_WIDTH)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('kis kepet NEM nagyit fel (felesleges bajtok lennenek)', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const src = join(TMP, 'kicsi.jpg')
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=120x90', '-frames:v', '1', src, '-y'])
      const out = await ensureThumb(src, TMP, { sha256: 'kicsi', file: 'kicsi.jpg', isVideo: false })
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error',
        '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', out!])
      // A force_original_aspect_ratio=decrease itt 480-ra nagyitott volna (merve).
      expect(Number(stdout.trim().replace(/\D/g, ''))).toBe(120)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('masodszorra mar nem keszit ujat, a meglevot adja vissza', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const { statSync, utimesSync } = await import('node:fs')
      const src = join(TMP, 'k.jpg')
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', src, '-y'])
      const entry = { sha256: 'ketszer', file: 'k.jpg', isVideo: false }
      const a = await ensureThumb(src, TMP, entry)
      // Visszamenolegesitjuk az idot: ha UJRA keszulne, a datum megvaltozna.
      utimesSync(a!, new Date(0), new Date(0))
      const b = await ensureThumb(src, TMP, entry)
      expect(b).toBe(a)
      expect(statSync(b!).mtimeMs).toBe(0)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('egyszerre erkezo kereseknel EGY munka fut, nem ketto', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const src = join(TMP, 'egyszerre.jpg')
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=800x600', '-frames:v', '1', src, '-y'])
      const entry = { sha256: 'egyszerre', file: 'egyszerre.jpg', isVideo: false }
      // Gorgetesnel ugyanarra a kepre tobb keres is erkezhet egyszerre. Nem az
      // a kerdes, hogy ugyanazt az utvonalat adjak-e vissza (azt akkor is
      // adnak, ha harom ffmpeg fut), hanem hogy HANY munka indult el.
      resetThumbRunCount()
      const [a, b, c] = await Promise.all([
        ensureThumb(src, TMP, entry), ensureThumb(src, TMP, entry), ensureThumb(src, TMP, entry),
      ])
      expect(a).toBeTruthy()
      expect(b).toBe(a)
      expect(c).toBe(a)
      expect(thumbRunCount(), 'harom keres, de csak EGY ffmpeg futhat').toBe(1)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('romlott fajlbol NEM lesz bolyeg, es fel-fajl sem marad utana', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const { readdirSync } = await import('node:fs')
      const bad = join(TMP, 'romlott.jpg')
      writeFileSync(bad, 'ez nem kep, csak szoveg')
      const out = await ensureThumb(bad, TMP, { sha256: 'romlott', file: 'romlott.jpg', isVideo: false })
      expect(out, 'ervenytelen fajlbol nem szabad bolyegnek lennie').toBeNull()
      const bent = existsSync(join(TMP, THUMB_DIRNAME)) ? readdirSync(join(TMP, THUMB_DIRNAME)) : []
      expect(bent.filter((f) => f.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('sikertelen futas utan a fel-fajlt ELOBB dobjuk el, csak azutan neveznenk at', () => {
    const dob = route.indexOf('if (!ok) { try { rmSync(tmp')
    expect(dob, 'nincs is eldobas').toBeGreaterThan(0)
    expect(dob).toBeLessThan(route.indexOf('renameSync(tmp, out)'))
  })

  it('rovid videonal a tekeres tulfut -- ilyenkor az ELSO kockat veszi', async () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    try {
      const { statSync } = await import('node:fs')
      const src = join(TMP, 'rovid.mp4')
      // 0,4 masodperc: az 1. masodpercre tekerve az ffmpeg 0-val LEP KI, de
      // fajlt nem keszit (merve). Ezert nem eleg a kilepokodot nezni.
      await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '0.4', src, '-y'])
      const out = await ensureThumb(src, TMP, { sha256: 'rovid', file: 'rovid.mp4', isVideo: true })
      expect(out, 'a rovid videobol is kell kocka').toBeTruthy()
      expect(statSync(out!).size).toBeGreaterThan(0)
    } finally {
      rmSync(TMP, { recursive: true, force: true })
    }
  })

  it('a bolyegnek KULON ETag-je van -- kulonben rossz meretu kep jonne elo', () => {
    // Ha a bolyeg es a teljes kep ugyanazt az azonositot kapna, a bongeszo a
    // mar eltarolt NAGY kepre kapna 304-et egy bolyeg-kereskor.
    expect(route).toContain('t${entry.sha256}')
  })

  it('a bolyeg-ag feltetel nelkul nem kapcsolhato ki', () => {
    // A 'false && ...' alaku kikapcsolas kulonben eszrevetlen maradna: minden
    // tobbi ellenorzes tovabbra is igaz lenne, a racs megis a teljes fajlt kapna.
    expect(route).toContain("if (url.searchParams.get('size') === 'thumb') {")
  })

  it('videot bolyeg nelkul SEM kuldunk ki a racsba', () => {
    // Egy 1,8 GB-os fajl a racsban rosszabb, mint egy jelzo negyzet.
    const at = route.indexOf("code: 'no_thumb'")
    expect(at, 'nincs is vedelem').toBeGreaterThan(0)
    expect(route.slice(at - 300, at)).toContain('entry.isVideo')
  })

  it('torleskor a bolyeg is megy vele', () => {
    expect(route).toContain('join(ownerDir, THUMB_DIRNAME, thumbFileName(entry))')
  })

  it('az egyformak KOZOS bolyeget nem torli el az egyik peldany eldobasa', () => {
    // A dedupe a fajlnev szerinti bolyeget dobja, a lenyomat szerintit SOHA:
    // az eppen a megtartott ikerpar kozos bolyege.
    expect(route).toContain('thumbFileName({ file: f.file })')
  })
})

// ===========================================================================
// A kliens oldal: mit ker le, es mit tesz el
// ===========================================================================
describe('a Fotok racs kliens-oldalon', () => {
  it('a racs BOLYEGKEPET ker, nem a teljes fajlt', () => {
    expect(app).toContain('_photosMediaUrl(id, account, true)')
    expect(app).toContain("(thumb ? '&size=thumb' : '')")
  })

  it('a nagy nezet a TELJES fajlt keri', () => {
    expect(app).toContain('_photosMediaUrl(id, account, false)')
    const at = app.indexOf('function _photosLoadFull')
    expect(at, 'nincs is teljes-meretu betoltes').toBeGreaterThan(0)
  })

  it('videot nagyban SEM tolt le egeszben', () => {
    const at = app.indexOf('if (isVideo) return')
    expect(at, 'nincs vedelem a nagy nezetben').toBeGreaterThan(0)
    // ...es a vedelem a HIVAS elott all (nem a fuggveny definiciója elott:
    // az korabban szerepel a fajlban, es hamis biztonsagot adna).
    expect(at).toBeLessThan(app.lastIndexOf('_photosLoadFull(img, id, account)'))
  })

  it('csak a kepernyo koze ero kepek indulnak el', () => {
    expect(app).toContain('new IntersectionObserver')
    // A regi, mindent egyszerre indito valtozat nem maradhatott bent.
    expect(app).not.toContain('_drivePool(photos, PHOTOS_THUMB_CONCURRENCY')
    // Figyelo nelkuli regi bongeszon inkabb toltson mindent, mint semmit.
    expect(app).toContain("if (typeof IntersectionObserver !== 'function') { tiles.forEach(start); return }")
  })

  it('a mar egyszer lehozott kep a bongeszo tarabol jon vissza', () => {
    expect(app).toContain('caches.open(PHOTOS_CACHE)')
    expect(app).toContain('store.match(url)')
    // Csak a SIKERES valasz kerulhet a tarba.
    const at = app.indexOf('store.put(url, res.clone())')
    expect(at, 'nem tesz el semmit').toBeGreaterThan(0)
    expect(app.slice(at - 120, at)).toContain('res.ok')
  })

  it('a tar hianya nem torheti el az oldalt (nem biztonsagos eredeten nincs)', () => {
    expect(app).toContain("'caches' in window")
    // Ilyenkor sima halozati keres a tartalek.
    expect(app).toContain('return fetch(url)')
  })

  it('torleskor a bongeszo tarabol is kikerul', () => {
    const at = app.indexOf('store.delete(_photosMediaUrl(id, account, thumb))')
    expect(at, 'a torolt kep bajtjai ottmaradnanak a gepen').toBeGreaterThan(0)
  })
})
