/**
 * KETIRANYU szinkron: a gepen keszult valtozas FELMEGY a Drive-ra.
 *
 * Boss, 2026-08-15:
 *   "az egyiranyu az nem talalo. mert en szeretnem ha amit a gepemen szerkesztek
 *    az felmenne a drive ra! vagy ha a gepemen uj filet csinalok az is felmenne!
 *    ha a gepemen torlok valamit az fent is torlodne. es ami a driv on fent
 *    torlodik az nalam megmarad. az helyes. mert ha valaki feltori a drivomat
 *    akkor a gepemrol ne tudjon torolni."
 *
 * Ez a fajl NEM csak a forraskod szovegere illeszt. A dontesek, amiken adat
 * mulik -- "valtozott-e helyben", "mi van a helyi faban", "fekezzunk-e" --
 * VALODI fuggvenyhivasokkal, valodi fajlokkal futnak. (Egy tsc-hiba egyszer mar
 * atcsuszott a csak-szoveges tesztek alatt: azok akkor is zoldek, ha a fordito
 * elhasal.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { localChanged, walkLocalFiles, shouldBrakeDeletions, needsDownload } from '../web/routes/drive-sync.js'
import { driveUploadMime } from '../web/routes/drive-browser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'drive-sync.ts'), 'utf8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ketiranyu-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('helyi valtozas felismerese (valodi fajlokon)', () => {
  it('a friss, meg nem ismert bejegyzes NEM szamit helyi valtozasnak', () => {
    // Kulonben az atallas utani ELSO futas az egesz depot felkuldene.
    const p = join(dir, 'regi.txt')
    writeFileSync(p, 'tartalom')
    const st = statSync(p)
    expect(localChanged({ path: 'regi.txt', modifiedTime: '', size: st.size }, st)).toBe(false)
  })

  it('megvaltozott datum = helyi valtozas', () => {
    const p = join(dir, 'datum.txt')
    writeFileSync(p, 'egy')
    const elso = statSync(p)
    const ismert = { path: 'datum.txt', modifiedTime: '', size: elso.size, localMtimeMs: elso.mtimeMs }
    expect(localChanged(ismert, elso)).toBe(false)
    // Egy oraval kesobbi modositas.
    const kesobb = new Date(Date.now() + 3600_000)
    utimesSync(p, kesobb, kesobb)
    expect(localChanged(ismert, statSync(p))).toBe(true)
  })

  it('valtozatlan datum mellett is valtozas, ha mas a MERET', () => {
    // Van szerkeszto, ami visszaallitja a modositasi idot; a masolo programok
    // is gyakran megorzik. A meret ilyenkor az egyetlen fogodzo.
    const p = join(dir, 'meret.txt')
    writeFileSync(p, 'rovid')
    const elso = statSync(p)
    const ismert = { path: 'meret.txt', modifiedTime: '', size: elso.size, localMtimeMs: elso.mtimeMs }
    writeFileSync(p, 'sokkal-sokkal-hosszabb-tartalom')
    utimesSync(p, elso.mtime, elso.mtime)      // a datumot visszaallitjuk
    const uj = statSync(p)
    expect(Math.round(uj.mtimeMs)).toBe(Math.round(elso.mtimeMs))
    expect(localChanged(ismert, uj)).toBe(true)
  })

  it('a szerkesztett Google Doc (.docx) MOST MAR helyi valtozas', () => {
    // Boss, 2026-08-15: "nem is ertem hogy miert nem lehet egy filet egy az
    // egybe felmasolni. de csinlad meg! ebbol ne legyen problema."
    // Egy az egyben tenyleg nem lehet (a Doc nem bajtok halmaza), de a lehozott
    // .docx VISSZAMEHET ugyanabba a fajlba -- merve az eles Drive-on.
    const p = join(dir, 'doc.docx')
    writeFileSync(p, 'akarmi')
    const st = statSync(p)
    const ismert = {
      path: 'doc.docx', modifiedTime: '', size: 1, localMtimeMs: 1, exported: true,
      uploadMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    expect(localChanged(ismert, st)).toBe(true)
  })

  it('a rajz/script (amit a Drive NEM vesz vissza) tovabbra sem valtozas', () => {
    // `uploadMime` nelkul nincs visszaut: a PNG visszairasa a Google Rajzra
    // merve 400-zal all meg. Ezt minden futasban ujraprobalni ertelmetlen.
    const p = join(dir, 'abra.png')
    writeFileSync(p, 'akarmi')
    const st = statSync(p)
    const ismert = { path: 'abra.png', modifiedTime: '', size: 1, localMtimeMs: 1, exported: true }
    expect(localChanged(ismert, st)).toBe(false)
  })

  it('ismeretlen bejegyzes vagy hianyzo fajl eseten nem allitunk semmit', () => {
    expect(localChanged(undefined, { mtimeMs: 1, size: 1 })).toBe(false)
    expect(localChanged({ path: 'x', modifiedTime: '', size: 1, localMtimeMs: 1 }, null)).toBe(false)
  })
})

describe('a helyi fa bejarasa (valodi konyvtaron)', () => {
  it('minden fajlt megtalal, almappaban is, relativ uttal', () => {
    const gyoker = join(dir, 'fa')
    mkdirSync(join(gyoker, 'szamlak', '2026'), { recursive: true })
    writeFileSync(join(gyoker, 'egy.txt'), 'a')
    writeFileSync(join(gyoker, 'szamlak', 'ketto.txt'), 'b')
    writeFileSync(join(gyoker, 'szamlak', '2026', 'harom.txt'), 'c')
    const { files, dirs, csonkolt } = walkLocalFiles(gyoker)
    expect(csonkolt).toBe(false)
    expect(files.map((f) => f.replace(/\\/g, '/')).sort())
      .toEqual(['egy.txt', 'szamlak/2026/harom.txt', 'szamlak/ketto.txt'])
    expect(dirs.map((d) => d.replace(/\\/g, '/')).sort()).toEqual(['szamlak', 'szamlak/2026'])
  })

  it('a felbeszakadt letoltes (.part) NEM kerul fel', () => {
    // A `.part` egy eppen zajlo letoltes fele fajlja. Felkuldeni annyi, mint
    // egy csonka fajlt ratolteni a Drive-on levo epre.
    const gyoker = join(dir, 'part')
    mkdirSync(gyoker, { recursive: true })
    writeFileSync(join(gyoker, 'kesz.txt'), 'ok')
    writeFileSync(join(gyoker, 'fele.txt.part'), 'fel')
    expect(walkLocalFiles(gyoker).files).toEqual(['kesz.txt'])
  })

  it('a felso hatart betartja, es SZOL, hogy csonka', () => {
    const gyoker = join(dir, 'sok')
    mkdirSync(gyoker, { recursive: true })
    for (let i = 0; i < 10; i++) writeFileSync(join(gyoker, `f${i}.txt`), 'x')
    const eredmeny = walkLocalFiles(gyoker, 4)
    expect(eredmeny.files.length).toBe(4)
    expect(eredmeny.csonkolt).toBe(true)
  })

  it('nem letezo konyvtaron nem hasal el', () => {
    expect(walkLocalFiles(join(dir, 'nincs-ilyen')).files).toEqual([])
  })
})

describe('vészfék: tomeges torles megallitasa', () => {
  it('par fajl torlese atmegy -- ez hetkoznapi', () => {
    expect(shouldBrakeDeletions(1, 10)).toBe(false)
    expect(shouldBrakeDeletions(3, 10)).toBe(false)   // a kuszob alatt/rajta
  })

  it('a nyilvantartas nagy hanyada MEGALL', () => {
    expect(shouldBrakeDeletions(50, 100)).toBe(true)
    expect(shouldBrakeDeletions(4, 10)).toBe(true)    // 40% es 3 folott
  })

  it('a lecsatolt lemez esete: minden eltunt -> fek', () => {
    // Ez a valodi rem: a depo nincs a helyen, es a "hu" szinkron letorolne az
    // egesz Drive-ot. 3000 fajlbol 3000 -> semmi nem megy fel.
    expect(shouldBrakeDeletions(3000, 3000)).toBe(true)
  })

  it('kis konyvtarban a szazalek nem huz be tevesen', () => {
    // 3 fajlbol 3 = 100%, de a darabszam a kuszob alatt van: valodi torles is
    // lehet, es a fek nem szolhat bele minden aprosagba.
    expect(shouldBrakeDeletions(3, 3)).toBe(false)
    expect(shouldBrakeDeletions(0, 0)).toBe(false)
  })
})

describe('a torles a KUKABA megy, nem veglegesen', () => {
  it('`trashed: true` PATCH, nem DELETE keres', () => {
    // A kulonbseg 30 nap visszavonasi ido. Feltores ellen ugyanugy ved (a
    // tamado a GEPRE nem lat ra), sajat baleset ellen viszont menedek.
    expect(route).toContain("body: JSON.stringify({ trashed: true })")
    expect(route).not.toContain("method: 'DELETE'")
  })
})

describe('a fekek a helyukon vannak, a helyes SORRENDBEN', () => {
  it('csonka bejaras utan a felmeno ag el sem indul', () => {
    // Hianyos kepbol nem szabad "ez mar nincs meg" kovetkeztetest levonni.
    expect(route).toContain('a Drive bejárása hiányos maradt')
    expect(route.indexOf('a Drive bejárása hiányos maradt')).toBeLessThan(route.indexOf('--- feltoltes'))
  })

  it('a lekert mappa hibaja is csonkanak szamit', () => {
    // 403 egy mappan: a tartalmat nem ismerjuk, tehat nem "tunt el".
    expect(route).toContain('// Egy be nem jart mappa = hianyos kep. A felmeno ag ezutan mar nem')
    // A csonkasag OKA is rogzul, nem csak a tenye: eppen ez a kulonbseg
    // "elertuk a felso hatart" es "egy mappat nem tudtam kiolvasni" kozott --
    // a ketto MAS teendot kivan a felhasznalotol.
    expect(route).toContain("csonkaOkok.add('olvasási hiba')\n      continue")
  })

  it('hianyzo helyi mappa != mindent toroltel', () => {
    expect(route).toContain('a helyi mappa nem található – a feltöltés kimaradt')
  })

  it('serult beallitas: a felmeno ag kimarad, de a kapcsolo NEM all el', () => {
    // Ures allapotbol minden helyi fajl "ujnak" latszik -> az egesz depo
    // felmenne. A `corrupt` viszont csak erre a futasra szol...
    expect(route).toContain('corrupt: true')
    expect(route).toContain('a szinkron beállítás-fájlja sérült')
    // ...es SOSE kerul lemezre, kulonben orokre lekapcsolna a funkciot.
    expect(route).toContain('const { corrupt, ...lemezre } = cfg')
    expect(route).toContain('JSON.stringify(lemezre, null, 2)')
  })
})

describe('utkozes: a GEP nyer', () => {
  it('ha mindket helyen valtozott, a letoltes kimarad', () => {
    // A Boss szamara a gep az igazsag, a Drive a mentes. A Drive-beli valtozat
    // nem vesz el: feltoltes utan a Google verzio-tortenetebol elohozhato.
    expect(route).toContain('if (localChanged(known, helyiStat))')
    expect(route).toContain('mindkét helyen módosult – a gépeden lévő marad')
  })

  it('a Drive-on ATNEVEZETT fajl nem hagy maga utan regi nevu peldanyt', () => {
    // Merve az eles Drive-on (2026-08-15): az atnevezes FELVISZI a
    // `modifiedTime`-ot, tehat a fajl az uj neven jon le. Ha a regi nevu
    // peldany a gepen maradna, a felmeno ag UJ fajlkent kuldene vissza -- az
    // atnevezes utan ujra megjelenne a regi nev is (egy Doc mellett ravadaszul
    // egy idegen Word-fajlkent).
    expect(route).toContain("const regiAbs = known && known.path !== rel ? join(base, known.path) : ''")
    expect(route).toContain('renameSync(regiAbs, dest)')
    // Atnevezes, NEM torles: egy bajt sem veszhet el a gepen.
    expect(route).not.toContain('rmSync(regiAbs')
    expect(route).not.toContain('unlinkSync(regiAbs')
  })

  it('ket Drive-fajl SOSE eshet egy helyi utra (nevutkozes)', () => {
    // Egy Doc "Jelentes" a lemezen "Jelentes.docx" -- de ugyanott lehet egy
    // VALODI "Jelentes.docx" is (a Drive "Google Doc-ka alakitas" epp ilyen
    // part hagy). Felvaltva irnanak egymasra, a felmeno ag pedig az egyik
    // tartalmat kuldene a MASIK dokumentumba: idegen dokumentum felulirasa.
    expect(route).toContain('const hasznaltUtak = new Set<string>()')
    expect(route).toContain('két Drive-fájl esne ugyanarra a névre')
    // Az utkozo felekhez a felmeno ag hozza sem nyul -- se iras, se torles.
    expect(route).toContain('if (utkozoIdk.has(id)) continue')
    expect(route).toContain('.filter(([id, s]) => !utkozoIdk.has(id) && !helyiSet.has(s.path))')
  })

  it('ha kozben helyben is szerkesztetted, hozza sem nyulunk', () => {
    // Fent atneveztek, itt szerkesztetted: a GEP nyer, a tartalom megy fel a
    // mar atnevezett fajlba (ugyanaz a fajlazonosito).
    expect(route).toContain('a Drive-on átnevezték, a gépeden módosult – a tiéd marad, az megy fel')
  })

  it('a Drive-on torolt fajl a gepen NEM tunik el', () => {
    // Az egesz aszimmetria erte van: a lefele menet SOSE torol helyben.
    expect(route).not.toContain('rmSync(dest')
    expect(route).toContain('Drive-on torlodik: nalad MEGMARAD')
  })
})

describe('a serult beallitast nem irjuk felul', () => {
  it('mentes elott FELRETESSZUK az olvashatatlan fajlt', () => {
    // Kulonben egyetlen kattintas (kapcsolo, hozzaadas, levalasztas) veglegesiti
    // a serulest: a parosok listaja nyomtalanul eltunik, es a felhasznalo azt
    // latja, hogy a szinkronja "elfelejtett" mindent.
    expect(route).toContain('if (cfg.corrupt && existsSync(CONFIG_PATH))')
    expect(route).toContain('.serult-')
    expect(route).toContain('renameSync(CONFIG_PATH, felre)')
    // A felretetel a KIIRAS ELOTT all -- kulonben mar nincs mit menteni.
    expect(route.indexOf('renameSync(CONFIG_PATH, felre)'))
      .toBeLessThan(route.indexOf('writeFileSync(CONFIG_PATH, JSON.stringify(lemezre'))
  })

  it('a felretetel elhasalasa nem allitja meg a mentest', () => {
    // Csak olvashato mappa eseten a rename dobhat. Ha ezt nem fognank el, a
    // hozzaadas-gomb egy serult fajl miatt vegleg hasznalhatatlan lenne.
    expect(route).toContain('a serult beallitast nem tudtam felretenni')
  })

  it('a kepernyon is KIMONDJUK, hogy serult (nem csak a naploban)', () => {
    expect(route).toContain('configBroken: cfg.corrupt === true')
    expect(app).toContain('s.configBroken')
    expect(app).toContain('A szinkron beállítás-fájlja sérült')
  })
})

describe('a ket veszelyes kapcsolo LATSZIK es ALLITHATO', () => {
  it('ott van mindketto a kepernyon', () => {
    // "Amit nem lehet a kepernyon ellenorizni, arrol a felhasznalo nem tudja
    // eldonteni, be van-e kapcsolva." A felmeno ag IR a Drive-ra.
    expect(html).toContain('id="depoSyncUpload"')
    expect(html).toContain('id="depoSyncDeleteUp"')
    expect(html).toContain('id="depoSyncBrake"')
  })

  it('az allasukat a KISZOLGALO mondja meg, nem a HTML alapertek', () => {
    // Kulonben minden oldalfrissites utan "be"-t mutatna, akkor is, ha ki van
    // kapcsolva -- es a user azt hinne, felmegy a munkaja, pedig nem.
    expect(route).toContain('upload: cfg.upload !== false')
    expect(route).toContain('deleteUp: cfg.deleteUp !== false')
    expect(app).toContain('up.checked = s.upload !== false')
    expect(app).toContain('del.checked = s.deleteUp !== false')
  })

  it('a valtoztatas sajat vegpontra megy (a futas nem allithatja at)', () => {
    expect(route).toContain("path === '/api/drive/sync/settings' && method === 'POST'")
    expect(app).toContain("_depoPost('/api/drive/sync/settings', kert)")
  })

  it('sikertelen mentesnel VISSZAALL a jelolonegyzet', () => {
    // Kulonben a kepernyon "ki" allna, a kiszolgalon meg "be" -- pont az a
    // hazugsag, ami ellen a kapcsolo van.
    expect(app).toContain('up.checked = !kert.upload')
    expect(app).toContain('del.checked = !kert.deleteUp')
  })

  it('a torles-atvitel szurke, ha a felmeno ag ki van kapcsolva', () => {
    // A torles a felmeno ag RESZE (`if (cfg.upload === false) return null`),
    // szoval kapcsolgathato "elo" gombkent hazudna.
    expect(route).toContain('if (cfg.upload === false) return null')
    expect(app).toContain('del.disabled = s.upload === false')
  })

  it('a kepernyo KIMONDJA, mi tortenik a Doc/Sheet/Slides fajlokkal', () => {
    // A felhasznalo a gepen egy .docx-et lat egy Doc helyen. Ha nem mondjuk
    // meg, mi lesz vele szerkesztes utan, csak talalgatni tud.
    expect(hu).toContain('A Google Docs, Sheets és Slides is oda-vissza megy')
    expect(hu).toContain('ugyanabba a dokumentumba')
    expect(hu).toContain('Rajzot és az Apps Scriptet a Google nem veszi vissza')
    expect(en).toContain('Google Docs, Sheets and Slides travel both ways too')
  })

  it('mindket nyelven van szovege', () => {
    expect(hu).toContain("'dsync.upload_label'")
    expect(hu).toContain("'dsync.delete_up_label'")
    expect(en).toContain("'dsync.upload_label'")
    expect(en).toContain("'dsync.delete_up_label'")
  })
})

describe('a szamlalok a kepernyon is megjelennek', () => {
  it('a feltoltott es a kukazott darabszam is ott van', () => {
    expect(app).toContain("job.uploaded || 0")
    expect(app).toContain("job.trashed || 0")
    expect(app).toContain('a Drive Kukájába került')
  })

  it('a vészfék sajat, feltuno dobozt kap', () => {
    expect(app).toContain("document.getElementById('depoSyncBrake')")
    expect(app).toContain('⚠ Vészfék: ')
  })
})

/**
 * A Google-natív fajlok visszautja.
 *
 * A hatterben allo MERES (eles Drive, 2026-08-15, ket eldobhato fajllal):
 *   - `PATCH /upload/.../{id}?uploadType=media` + `Content-Type: ...docx` egy
 *     Google Doc-ra: a valasz mimeType-ja `application/vnd.google-apps.document`
 *     MARADT, a tartalom pedig atvette a felkuldott .docx szoveget.
 *   - Ugyanez PNG-vel egy Google Rajzra: `400 Bad Request`.
 * Ezert megy fel a Doc/Sheet/Slide, es ezert nem a Rajz/Script.
 */
describe('Google-natív fajlok: van visszaut (Doc/Sheet/Slide), es nincs (Rajz/Script)', () => {
  it('a harom irodai tipus a SAJAT export-formatumaval megy vissza', () => {
    expect(driveUploadMime('application/vnd.google-apps.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(driveUploadMime('application/vnd.google-apps.spreadsheet'))
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(driveUploadMime('application/vnd.google-apps.presentation'))
      .toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('a rajz es a script NEM mehet vissza (a Drive 400-zal valaszol)', () => {
    expect(driveUploadMime('application/vnd.google-apps.drawing')).toBeNull()
    expect(driveUploadMime('application/vnd.google-apps.script')).toBeNull()
  })

  it('a kozonseges fajlok es az ismeretlen tipus nem kapnak kulon tipust', () => {
    // Egy .pdf-nek nincs "visszakonvertalas": az bajtrol bajtra megy fel.
    expect(driveUploadMime('application/pdf')).toBeNull()
    expect(driveUploadMime('application/vnd.google-apps.form')).toBeNull()
    expect(driveUploadMime(undefined)).toBeNull()
    expect(driveUploadMime('')).toBeNull()
  })

  it('a feltoltes ezt a tipust adja at, nem octet-streamet', () => {
    // Octet-streammel a Drive nem konvertalna: a Doc helyere egy nyers Word-
    // fajl kerulne, es a felhasznalo Doc-ja odalenne.
    expect(route).toContain('await updateDriveFile(meglevoId, abs, token, known?.uploadMime)')
    expect(route).toContain('contentType = \'application/octet-stream\'')
    expect(route).toContain("'Content-Type': contentType")
  })

  it('UGYANARRA a fajlazonositora megy vissza (nem uj fajl a regi helyere)', () => {
    // Ezen mulik a megosztas, a link es a Google verzio-tortenet megmaradasa.
    expect(route).toContain('${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=media')
  })

  it('a feltoltes utan sem vesz el az `exported`/`uploadMime` jelzes', () => {
    // Ha elveszne, a kovetkezo futas kozonseges fajlkent kezelne a Doc-ot:
    // minden alkalommal ujra lehozna, es octet-streamkent kuldene vissza.
    expect(route).toContain('state[meglevoId] = { ...known, path: teljes')
  })

  it('a MERET-osszehasonlitas kimarad az exportalt fajloknal', () => {
    // Merve: a Drive egy ures Docra 1024 bajtot mond, az exportalt .docx 6780.
    // Osszevetve minden Doc MINDEN futasban "valtozottnak" latszana.
    const doc = { path: 'd.docx', modifiedTime: '2026-01-01T00:00:00Z', size: 6780, exported: true }
    const letezo = join(dir, 'meret-doc.docx')
    writeFileSync(letezo, 'x')
    expect(needsDownload({ modifiedTime: '2026-01-01T00:00:00Z', size: '1024' }, doc, letezo)).toBe(false)
    // A datum viszont tovabbra is dont.
    expect(needsDownload({ modifiedTime: '2026-02-02T00:00:00Z', size: '1024' }, doc, letezo)).toBe(true)
    // Kozonseges fajlnal a meret valtozatlanul szamit.
    const sima = { path: 'd.pdf', modifiedTime: '2026-01-01T00:00:00Z', size: 10 }
    expect(needsDownload({ modifiedTime: '2026-01-01T00:00:00Z', size: '99' }, sima, letezo)).toBe(true)
  })

  it('a helyi torles a Google-natív fajlokra IS atmegy', () => {
    // A torles nem konvertalas: ott nincs "a bajtok nem egyeznek" kifogas.
    // (A vészfék ugyanugy elotte all, lasd a fenti describe-ot.)
    // Nincs `!s.exported` szures: a Doc torlese ugyanugy atmegy, mint a
    // tobbie. (Az `utkozoIdk` mas kerdes, lasd a nevutkozes-tesztet.)
    expect(route).toContain('const torlendok = Object.entries(state).filter(([id, s]) => !utkozoIdk.has(id) && !helyiSet.has(s.path))')
    expect(route).not.toContain('!s.exported && !helyiSet.has(s.path)')
  })

  it('amit a Drive nem vesz vissza, arrol SZOLUNK, nem csendben hagyjuk ki', () => {
    expect(route).toContain('ezt a Google nem veszi vissza (rajz/script), a helyi módosítás nem ment fel')
  })

  it('a regi bejegyzesek megkapjak a visszautat (kulonben sose mennenek fel)', () => {
    // A funkcio elott lementett Doc-oknal nincs `uploadMime`. Ha nem potolnank,
    // a mar meglevo depoban EGYETLEN Doc sem tudna felmenni -- a funkcio csak
    // ujratelepites utan mukodne.
    expect(route).toContain('known.uploadMime !== uploadMime')
    expect(route).toContain('hianyzikMime')
  })
})
