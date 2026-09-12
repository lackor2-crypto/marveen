/**
 * AZ AGENS KARTYAJA: A JELOLES MERES, NEM BEALLITAS -- ES A MUNKAMAPPA TALLOZHATO.
 *
 * Boss, 2026-09-12, ket kulon kerese ugyanarrol a kartyarol:
 *
 *  1. "be lehetett jelolni az aktualis chatet. a agent kartyajan a chat melett
 *     balrol volt egy jelolo gomb (...) de ezt mar meg kell szuntetni. ehejett
 *     inkabb ne kelljen jelolgetni semmit, hanem automatikusan az legyen jelolve
 *     amit a agent hasznal. (...) user ne tudjon kattintgatni jelolni."
 *
 *  2. "de valami kezzel kell beirni verzio van. az nem jo. tehat a gyokermappat
 *     kivalasztani kitallozva lehessen."
 *
 * MIERT FORRAS-OR AZ ELSO RESZ. A radiogomb visszacsempeszese nem okoz hibat:
 * a lap tovabbra is betoltodne, a gomb mukodne, es senki nem venne eszre, hogy
 * a tulaj sajat beszelgetesebe lehet megint iranyitani a munkat. Egy viselkedesi
 * teszt ezt nem fogna meg, mert a hiba EPP az, hogy egy muvelet LETEZIK. Ezert
 * a forrasban allitjuk meg.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  browseStatus, windowsParent, displayName, BROWSE_TTL_MS,
} from '../web/code-folder-browse.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const INDEX_HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

describe('agens-kartya: a felhasznalo nem allithatja at, melyik a beszelgetes', () => {
  it('nincs tobbe radiogomb a ful-sorokban', () => {
    // Nem csak az osztalynevet nezzuk: barmilyen radio-input ugyanezt a
    // kattintgathato valasztast hozna vissza mas nevvel.
    expect(
      /<input type="radio" class="cb-tab-radio"/.test(APP_JS),
      'a `cb-tab-radio` visszakerult a kartyara',
    ).toBe(false)
    expect(
      /name="cbtab-/.test(APP_JS),
      'a `cbtab-<projekt>` radio-csoport visszakerult -- ez megint kezi valasztast jelentene',
    ).toBe(false)
  })

  it('nincs tobbe kezi session-valasztas (`cbPickSession`)', () => {
    expect(APP_JS.includes('cbPickSession(')).toBe(false)
  })

  it('a jelzot rajzolo fuggveny nem ir sehova -- csak megmutat', () => {
    // A `pinned` MAGA nem tilos (a felvetel hasznalja), de a ful-sor melletti
    // jeloles nem rogzithet semmit.
    const from = APP_JS.indexOf('function cbTabMark(')
    expect(from, 'nincs meg a cbTabMark').toBeGreaterThan(0)
    const body = APP_JS.slice(from, APP_JS.indexOf('\n}\n', from))
    expect(body.includes('fetch(')).toBe(false)
    expect(body.includes('pinned')).toBe(false)
  })

  it('a jelzo HAROM allapotot mond kulon, es egyiket sem keveri', () => {
    for (const key of ['tab_mark_running', 'tab_mark_last', 'tab_mark_bound']) {
      expect(APP_JS.includes(key), `hianyzik a ${key} ag`).toBe(true)
      expect(HU.includes(`'cb.card.${key}'`), `hianyzik a magyar ${key}`).toBe(true)
      expect(EN.includes(`'cb.card.${key}'`), `hianyzik az angol ${key}`).toBe(true)
    }
  })

  it('a "meg nem futott" allapot NEM allitja, hogy az agens ott dolgozott', () => {
    // A NULLA KET DOLGOT JELENTHET: bekotes != futas. A szovegnek ezt ki kell
    // mondania, kulonben a felhasznalo azt hiszi, mar futott valami.
    const hu = /'cb\.card\.tab_mark_bound_help': '([^']*)'/.exec(HU)
    expect(hu, 'nincs magyar magyarazat a bekotott allapothoz').not.toBeNull()
    expect(hu![1]).toMatch(/EGYSZER SEM/)
  })

  it('a Kituz/Elenged gomb is eltunt a beallitasokbol', () => {
    expect(APP_JS.includes('cb-pin')).toBe(false)
  })
})

describe('munkamappa: tallozas gepeles helyett', () => {
  it('a felulet kinal tallozo gombot es dobozt', () => {
    expect(INDEX_HTML.includes('id="cbBrowseBtn"')).toBe(true)
    expect(INDEX_HTML.includes('id="cbBrowseBox"')).toBe(true)
    expect(APP_JS.includes("'/api/code/browse'")).toBe(true)
  })

  it('a kezi felvetel blokkja VEGIG ketnyelvu -- nincs benne beegetett magyar', () => {
    // Ez a blokk 2026-09-12-ig egyetlen `data-i18n` nelkul allt, mikozben a
    // szomszedja mar ketnyelvu volt.
    const start = INDEX_HTML.indexOf('id="cbManualAdd"')
    expect(start, 'nincs meg a kezi felvetel blokkja').toBeGreaterThan(0)
    const block = INDEX_HTML.slice(start, INDEX_HTML.indexOf('</details>', start))
    for (const m of block.matchAll(/<(label|summary|button|span|p)\b[^>]*>/g)) {
      const tag = m[0]
      if (/data-i18n/.test(tag)) continue
      // Csak-konteneri elemek: nincs sajat szovegük, a gyermekeik cimkezettek.
      if (tag === '<label' || /^<label\s+for="[^"]*">$/.test(tag)) continue
      if (/^<(span|p)>$/.test(tag)) continue
      // A JS-bol toltott, URESEN szuletett allapot-mezot nem cimkezzuk: nincs
      // sajat szovege. A benne megjeleno mondatokat viszont kulon teszt orzi
      // (lasd lentebb) -- kulonben itt csak athelyeznenk a beegetett magyart.
      if (/id="cbAddStatus"/.test(tag)) continue
      expect(/data-i18n/.test(tag), `ketnyelvusites nelkuli elem: ${tag}`).toBe(true)
    }
  })

  it('a felvetel uzeneteit is a nyelvi fajl adja, nem a kod', () => {
    // Ezek 2026-09-12-ig beegetett magyar mondatok voltak az `app.js`-ben --
    // a `data-i18n` ora vak rajuk, mert nem a HTML-ben alltak.
    const from = APP_JS.indexOf("tgt.id === 'cbAddBtn'")
    expect(from, 'nincs meg a felvetel kezeloje').toBeGreaterThan(0)
    // PONTOSAN ez a kezelo, nem egy karakterszamra becsult ablak: a 2600
    // karakteres vagas atlogott a szomszedos kezelobe, es annak a sajat
    // uzeneteire bukott el -- egy teszt, ami mas kodjat meri, hamisan riaszt.
    const body = APP_JS.slice(from, APP_JS.indexOf("if (tgt.id === 'cbBotSaveBtn'", from))
    expect(body).not.toMatch(/'Felvéve\.'/)
    expect(body).not.toMatch(/'Nem sikerült: '/)
    for (const k of ['cb.manual.err_no_name', 'cb.manual.err_no_folder', 'cb.manual.added', 'cb.manual.add_failed']) {
      expect(body.includes(k), `nem i18n-kulcsot hasznal: ${k}`).toBe(true)
      expect(HU.includes(`'${k}'`), `hianyzik a magyar ${k}`).toBe(true)
      expect(EN.includes(`'${k}'`), `hianyzik az angol ${k}`).toBe(true)
    }
  })

  it('minden tallozo-kulcsnak van magyar ES angol parja', () => {
    const keys = [...new Set([...APP_JS.matchAll(/'(cb\.browse\.[a-z_]+)'/g)].map((m) => m[1]))]
    expect(keys.length).toBeGreaterThan(4)
    for (const k of keys) {
      expect(HU.includes(`'${k}'`), `hianyzik a magyar ${k}`).toBe(true)
      expect(EN.includes(`'${k}'`), `hianyzik az angol ${k}`).toBe(true)
    }
  })

  it('a negy allapotot a felulet KULON mondja el', () => {
    // Ez a "nulla ket dolgot jelenthet" szabaly elso vedvonala: ha barmelyik ag
    // kiesik, egy ures lista es egy halott vegrehajto egyformanak latszik.
    for (const k of ['cb.browse.waiting', 'cb.browse.no_worker', 'cb.browse.empty', 'cb.browse.error']) {
      expect(APP_JS.includes(k), `a felulet nem kezeli kulon: ${k}`).toBe(true)
    }
  })
})

describe('tallozas: a "nem latok oda" sosem latszik "ures"-nek', () => {
  const base = { answeredAt: null, status: 'pending' as const, createdAt: 1000 }
  const STALE = 60_000

  it('ha a vegrehajto MEG SOSEM jelentkezett, az allapot no_worker -- nem pending', () => {
    expect(browseStatus(base, null, 2000, STALE)).toBe('no_worker')
  })

  it('ha a vegrehajto elavult, az allapot no_worker', () => {
    expect(browseStatus(base, 1000, 1000 + STALE + 1, STALE)).toBe('no_worker')
  })

  it('elo vegrehajtonal varakozunk', () => {
    expect(browseStatus(base, 1500, 2000, STALE)).toBe('pending')
  })

  it('valasz nelkul, de tul regen: expired -- nem pending vegtelenul', () => {
    expect(browseStatus(base, 1000 + BROWSE_TTL_MS, 1000 + BROWSE_TTL_MS + 1, STALE)).toBe('expired')
  })

  it('a MEGERKEZETT valaszt a vegrehajto kesobbi leallasa nem irja felul', () => {
    const answered = { answeredAt: 1200, status: 'ok' as const, createdAt: 1000 }
    expect(browseStatus(answered, null, 999_999, STALE)).toBe('ok')
  })
})

describe('Windows-utak: a szerver Linuxon fut, de Windows-utakat szamol', () => {
  it('a meghajto gyokerebol nincs feljebb', () => {
    expect(windowsParent('C:\\')).toBeNull()
    expect(windowsParent('C:')).toBeNull()
  })

  it('egy szinttel feljebb', () => {
    expect(windowsParent('C:\\Projects\\TradingBot')).toBe('C:\\Projects')
    expect(windowsParent('C:\\Projects')).toBe('C:\\')
  })

  it('a zaro jel nem szamit', () => {
    expect(windowsParent('C:\\Projects\\TradingBot\\')).toBe('C:\\Projects')
  })

  it('UNC-megoszto gyokerebol sincs feljebb', () => {
    expect(windowsParent('\\\\gep\\megoszto')).toBeNull()
    expect(windowsParent('\\\\gep\\megoszto\\proj')).toBe('\\\\gep\\megoszto')
  })

  it('ures utra null, nem osszeomlas', () => {
    expect(windowsParent('')).toBeNull()
    expect(windowsParent('   ')).toBeNull()
  })

  it('a megjeleno nev az utolso szegmens, meghajtonal maga a gyoker', () => {
    expect(displayName('C:\\Projects\\TradingBot')).toBe('TradingBot')
    expect(displayName('C:\\')).toBe('C:\\')
    expect(displayName('C:')).toBe('C:\\')
  })
})
