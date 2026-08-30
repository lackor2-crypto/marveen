// A kod-hid kartyaja ket KULONBOZO kerdesre valaszolt egymas alatt, es a ketto
// ellentmondasnak latszott (Boss, 2026-08-24):
//
//   "Nincs nyitott beszelgetes ebben a mappaban."
//   "kontextus: 108k token"
//
//   -> "hiszen ha nincs beszelgetes akor nem kellene lennie tokennek sem"
//
// Nem ellentmondas volt: a ful-lista azt mutatja, mi van EPPEN NYITVA a VS
// Code-ban (a worker `live` merese), a token pedig a mappahoz KOTOTT beszelgetes
// naplojabol jon, ami a lemezen marad a ful bezarasa utan is. A magyarazat
// viszont csak a tooltipben allt -- a kartya fo szovege hallgatott rola.
//
// Ez ugyanaz a hibafajta, mint a "nulla ket dolgot jelenthet": a felulet ket
// allitast tesz egymas melle anelkul, hogy feloldana. Ezert HAROM allapot van,
// mindharomnak sajat, a KOVETKEZO LEPEST mondo mondattal.
//
// web/app.js klasszikus szkript, nincs modul-hatara, ezert a tiszta segedeket
// zarojel-parositassal emeljuk ki es futtatjuk (az accounts-one-panel.test.ts
// idiomaja) -- igy a teszt a VISELKEDEST meri, nem a forras szoveget.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() zarojelei nincsenek parban`)
}

interface Tab {
  sessionId?: string; title?: string | null; live?: boolean | null; lastActivity?: number | null
  contextTokens?: number | null; mtime?: number | null
  current?: boolean; pid?: number | null; hasTranscript?: boolean; shortId?: string
}
interface Entry { tabs?: Tab[]; closedTabs?: Tab[]; tabsReason?: string; contextTokens?: number | null }

// A `t()` a KULCSOT adja vissza a behelyettesitett tokenekkel, hogy lassuk,
// melyik uzenet sult el es mi keruelt bele. A valodi szovegek meglete kulon
// allitas (lentebb), mindket nyelven.
const harness = `
  function t(key, vars) {
    if (!vars) return key
    return key + '|' + Object.keys(vars).map(function (k) { return k + '=' + vars[k] }).join(',')
  }
  function escapeHtml(s) { return String(s) }
  function escapeAttr(s) { return String(s) }
  // A relativ ido sajat, mar bevalt segedje -- itt csak annyi szamit, hogy a
  // sorba beleker valami. Az idoformazas nem ennek a tesztnek a targya.
  function formatRelative(ts) { return 'relativ:' + ts }
  ${extractFn(app, 'cbFmtKTokens')}
  ${extractFn(app, 'cbTabRows')}
  ${extractFn(app, 'cbHasTabRows')}
  ${extractFn(app, 'cbTabsEmptyHasCtx')}
  ${extractFn(app, 'cbTabOpenBtn')}
  ${extractFn(app, 'cbClosedTabsHtml')}
  ${extractFn(app, 'cbTabsPickHtml')}
  ${extractFn(app, 'cbEntryFromProject')}
  return {
    cbTabsPickHtml: cbTabsPickHtml, cbTabsEmptyHasCtx: cbTabsEmptyHasCtx,
    cbFmtKTokens: cbFmtKTokens, cbHasTabRows: cbHasTabRows,
    cbClosedTabsHtml: cbClosedTabsHtml, cbEntryFromProject: cbEntryFromProject,
  }
`
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const api = new Function(harness)() as {
  cbTabsPickHtml: (e: Entry) => string
  cbTabsEmptyHasCtx: (e: Entry) => boolean
  cbFmtKTokens: (n: number) => string
  cbHasTabRows: (e: Entry) => boolean
  cbClosedTabsHtml: (e: Entry) => string
  cbEntryFromProject: (r: Record<string, unknown>, ctx?: Record<string, unknown>) => Entry
}

describe('ures ful-lista + mert kontextus: a kartya nem mond ket dolgot egyszerre', () => {
  it('a munkas latja, hogy nincs nyitva, DE van naplo -> kimondja a tokent is', () => {
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'ok', contextTokens: 108_000 })
    expect(html).toContain('cb.card.tabs_none_ctx|n=108')
    // A regi, hallgatag mondat NEM jelenhet meg ilyenkor.
    expect(html).not.toContain('cb.card.tabs_none|')
    expect(html).not.toMatch(/cb\.card\.tabs_none"/)
    // A tooltip a NYERS tokenszamot mondja, ahogy a tobbi kontextus-sugo is.
    expect(html).toContain('cb.card.tabs_none_ctx_help|n=108000')
  })

  it('a munkas latja, hogy nincs nyitva, es nincs naplo -> a regi mondat marad', () => {
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'empty', contextTokens: null })
    expect(html).toContain('cb.card.tabs_none')
    expect(html).not.toContain('tabs_none_ctx')
  })

  it('nem latunk oda (a munkas nem jelentkezett) -> a token SEM valtoztat rajta', () => {
    // Ez a lenyeg: mert kontextus mellett sem allithatjuk, hogy "nincs nyitva",
    // ha egyszer nem lattunk oda. A nulla ket dolgot jelenthet.
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'stale', contextTokens: 108_000 })
    expect(html).toContain('cb.card.tabs_blind')
    expect(html).not.toContain('tabs_none')
  })

  it('a 0 token nem meres, hanem hianyzo adat -> nem allunk elo szammal', () => {
    expect(api.cbTabsEmptyHasCtx({ tabs: [], tabsReason: 'ok', contextTokens: 0 })).toBe(false)
    const html = api.cbTabsPickHtml({ tabs: [], tabsReason: 'ok', contextTokens: 0 })
    expect(html).not.toContain('tabs_none_ctx')
  })

  it('ha van elo ful, az ures-ag egyaltalan nem fut', () => {
    const e: Entry = { tabs: [{ sessionId: 'abcdef12', title: 'csv elemzes', live: true, contextTokens: 73_000 }], tabsReason: 'ok', contextTokens: 73_000 }
    expect(api.cbTabsEmptyHasCtx(e)).toBe(false)
    const html = api.cbTabsPickHtml(e)
    expect(html).not.toContain('tabs_none')
    expect(html).not.toContain('tabs_blind')
  })

  it('az ures-ag akkor fut, ha a szerver TENYLEG nem kuldott sort', () => {
    // 2026-08-30 elott ez a teszt egy nem futo sort adott at, es azt varta,
    // hogy a felulet SAJAT MAGA dobja el. Az a masodik szures szunt meg: a
    // szetvalogatas a szerveren tortenik (`listCodeTabs`), a felulet azt
    // jeleniti meg, amit kapott. Ket szuro egymas ellen dolgozott -- ez volt az
    // egyik oka annak, hogy a hiba 12 koron at visszajart.
    const e: Entry = { tabs: [], closedTabs: [{ sessionId: 'abcdef12', live: false, contextTokens: 108_000 }], tabsReason: 'ok', contextTokens: 108_000 }
    expect(api.cbTabsEmptyHasCtx(e)).toBe(true)
    expect(api.cbTabsPickHtml(e)).toContain('cb.card.tabs_none_ctx|n=108')
  })
})

describe('a token-szam egy helyen formazodik', () => {
  it('10k folott egesz, alatta egy tizedes, magyar tizedesvesszovel', () => {
    expect(api.cbFmtKTokens(108_000)).toBe('108')
    expect(api.cbFmtKTokens(73_000)).toBe('73')
    expect(api.cbFmtKTokens(7_300)).toBe('7,3')
  })

  it('a keplet PONTOSAN egyszer szerepel: a helper torzseben', () => {
    // Nem a keplet tiltott, hanem az ISMETLESE -- kulonben ket alakban allna
    // ugyanaz a szam a kartyan. Ezert szamolunk, nem tiltunk.
    const hits = app.match(/\/ 1000\)\.toFixed/g) || []
    expect(hits.length, 'a token-formazas tobb helyen van kezzel leirva').toBe(1)
    expect(extractFn(app, 'cbFmtKTokens')).toContain('/ 1000).toFixed')
    expect(app).not.toContain('(tb.contextTokens / 1000).toFixed')
  })
})

// ★ A BEKOTOTT SOR SOSEM ESIK KI (Boss, 2026-08-28).
//
// "hat ha me van a bekototte, akor miert nem jeleniti meg a chat beszelgetest a
// kartyan??? miert csk mondja hogy megvan de nem mutatja meg? idiotasag."
//
// A szerver KIFEJEZETTEN megtartja a bekotott (`current`) fulet a listaban akkor
// is, ha a folyamata mar nem fut (`filterLive`, code-bridge-store.ts) -- pont
// azert, hogy a kartya ne latsszon cimezhetetlennek. A felulet viszont meg
// egyszer szurt, kivetel nelkul, es eldobta azt, amit a szerver megorzott. Az
// eredmeny: a kartya TUDOTT a beszelgetesrol (kiirta a tokenjet), es megsem
// mutatta meg. Ezek a tesztek azt kotik le, hogy ez ne fordulhasson elo ujra.
describe('a bekotott beszelgetes sora akkor is kiall, ha nem fut', () => {
  const bound: Entry = {
    tabs: [{ sessionId: 'abcdef12-1111-2222-3333-444455556666', title: 'Fejlesztes', live: false, current: true, contextTokens: 112_000, hasTranscript: true }],
    tabsReason: 'ok',
    contextTokens: 112_000,
  }

  it('a sor megjelenik -- nem az "ures lista" uzenet', () => {
    expect(api.cbHasTabRows(bound)).toBe(true)
    expect(api.cbTabsEmptyHasCtx(bound)).toBe(false)
    const html = api.cbTabsPickHtml(bound)
    expect(html).toContain('Fejlesztes')
    // Pont ez a mondat volt a panasz targya: tobbe nem sul el, ha van sor.
    expect(html).not.toContain('tabs_none_ctx')
    expect(html).not.toContain('tabs_blind')
  })

  it('ki is mondja, hogy NEM FUT -- a jelzes meres, nem tipp', () => {
    expect(api.cbTabsPickHtml(bound)).toContain('cb.card.tab_not_running')
  })

  it('a futo ful nem kap "nem fut" cimket', () => {
    const live: Entry = { tabs: [{ sessionId: 'a', title: 'x', live: true, current: true }], tabsReason: 'ok' }
    expect(api.cbTabsPickHtml(live)).not.toContain('tab_not_running')
  })

  it('a NEM bekotott, nem futo ful a LEGUTOBBI csoportban jelenik meg', () => {
    // Boss, 2026-08-23: "amit a vscode ban kitorolnek azt a maveen kartyaja se
    // mutassa" -- a "Fut most" lista tehat tiszta marad. De nyomtalanul nem
    // tunhet el: azt, hogy a VS Code-ban be van-e zarva, nem tudjuk megmerni
    // (claude-code#74894), tehat nem is allitjuk. Amit merunk: nem fut.
    const e: Entry = { tabs: [], closedTabs: [{ sessionId: 'abcdef12', title: 'tegnapi', live: false, contextTokens: 108_000 }], tabsReason: 'ok' }
    expect(api.cbHasTabRows(e)).toBe(false)
    const html = api.cbClosedTabsHtml(e)
    expect(html).toContain('tegnapi')
    expect(html).toContain('cb.card.tabs_closed')
  })
})

describe('a beszelgetes TARTALMA megnyithato', () => {
  it('van gomb, ha a worker elkuldte a naplo utjat', () => {
    const html = api.cbTabsPickHtml({ tabs: [{ sessionId: 's1', title: 'x', live: true, current: true, hasTranscript: true }], tabsReason: 'ok' })
    expect(html).toContain('cb-tab-open')
    expect(html).toContain('cb.card.tab_open')
  })

  it('NINCS gomb, ha nem latunk oda (regi worker) -- nem kinalunk halott gombot', () => {
    const html = api.cbTabsPickHtml({ tabs: [{ sessionId: 's1', title: 'x', live: true, current: true, hasTranscript: false }], tabsReason: 'ok' })
    expect(html).not.toContain('cb-tab-open')
  })
})

// Boss, 2026-08-28: "a kartyan csak eg chat van megjelenitve, most, de a vscode
// ban van vagy 3 beszelgetes." A nyitott FUL es a futo FOLYAMAT ket kulonbozo
// dolog: a masik ket beszelgetes ott ult a VS Code panelen, de nem futott.
describe('a mappa tobbi beszelgetese elerheto marad', () => {
  it('nincs blokk, ha nincs mit mutatni -- ures reszletezot nem rakunk ki', () => {
    expect(api.cbClosedTabsHtml({ closedTabs: [] })).toBe('')
    expect(api.cbClosedTabsHtml({})).toBe('')
  })

  it('a sorok kiallnak, es a tartalmuk is megnyithato', () => {
    const html = api.cbClosedTabsHtml({
      closedTabs: [
        { sessionId: '3d3f27b8', title: 'tegnapi kor', contextTokens: 45_000, mtime: 1_756_000_000_000, hasTranscript: true },
        { sessionId: 'be83a34f', title: 'masik', hasTranscript: false },
      ],
    })
    expect(html).toContain('cb.card.tabs_closed|n=2')
    expect(html).toContain('tegnapi kor')
    expect(html).toContain('masik')
    // Az elsore van gomb (van naplo-ut), a masodikra nincs.
    expect((html.match(/cb-tab-open/g) || []).length).toBe(1)
    // Az "utoljara irt" csak ott all ki, ahol tenyleg megmertuk.
    expect((html.match(/cb-tab-when/g) || []).length).toBe(1)
  })
})

// A HUZALOZAS, nem a ket vege kulon-kulon.
//
// Boss, 2026-08-28, kepernyokeppel: a VS Code panelen ott allt a "47-es kanban
// kartya", a Marveen kartyajan nem -- "ugyanannak kellene latszania!". A
// szerver kuldte, a rajzolo kiirta volna; a sorbol bejegyzest keszito lepes
// ejtette el. A fenti ket describe VEGIG ZOLD volt kozben, mert mindketto a
// sajat vegen fogta meg a szalat. Ez a blokk azt meri, ami elszakadt.
describe('a szerver sora es a kartya-bejegyzes kozott nem vesz el beszelgetes', () => {
  const row = {
    project: 'fejlesztes',
    workspacePath: 'f:\\Munka\\Projekt',
    tabs: [{ sessionId: 'be83a34f', title: 'epp fut', live: true, current: true }],
    closedTabs: [{ sessionId: '3d3f27b8', title: '47-es kanban kartya', live: false, hasTranscript: true }],
  }

  it('a closedTabs atjut a bejegyzesbe, es ki is rajzolodik', () => {
    const e = api.cbEntryFromProject(row, { online: true, tabsReason: 'ok' })
    expect(e.closedTabs).toHaveLength(1)
    // A vegallomas: a sor tenyleg ott van a kartyan.
    expect(api.cbClosedTabsHtml(e)).toContain('47-es kanban kartya')
  })

  it('a fo lista valtozatlan marad (a futo beszelgetes nem keveredik oda)', () => {
    const e = api.cbEntryFromProject(row, { online: true, tabsReason: 'ok' })
    expect(e.tabs).toHaveLength(1)
    expect(api.cbTabsPickHtml(e)).toContain('epp fut')
    expect(api.cbTabsPickHtml(e)).not.toContain('47-es kanban kartya')
  })

  it('regi backend (nincs closedTabs kulcs) -> URES lista, nem undefined', () => {
    const e = api.cbEntryFromProject({ project: 'p', workspacePath: 'w', tabs: [] }, {})
    expect(e.closedTabs).toEqual([])
    expect(api.cbClosedTabsHtml(e)).toBe('')
  })

  it('a rajzolo minden mezot a bejegyzesbol kap -- a kettonek egyeznie kell', () => {
    // A `cbClosedTabsHtml`/`cbTabsPickHtml` altal olvasott kulcsok mind
    // szerepelnek a bejegyzesben. Igy egy kesobbi UJ mezo sem tud ugyanigy,
    // NEMAN kimaradni: aki kiolvassa, annak eloszor ide kell felvennie.
    const e = api.cbEntryFromProject(row, { online: true, note: 'x', roleHolder: 'vscode:p', tabsReason: 'ok' })
    for (const key of ['tabs', 'closedTabs', 'tabsReason', 'contextTokens', 'model', 'workspacePath', 'roleHolder', 'project', 'online', 'note']) {
      expect(Object.prototype.hasOwnProperty.call(e, key), `hianyzo mezo: ${key}`).toBe(true)
    }
  })
})

describe('a szoveg mindket nyelven megvan', () => {
  for (const key of [
    'cb.card.tab_not_running', 'cb.card.tab_not_running_help',
    'cb.card.tab_open', 'cb.card.tab_open_help',
    'cb.card.tabs_closed', 'cb.card.tabs_closed_help', 'cb.card.tab_last_write',
    'conversation.you', 'conversation.empty_no_path', 'conversation.empty_no_session',
    'conversation.empty_too_large', 'conversation.empty_unsafe', 'conversation.empty_unreachable',
  ]) {
    it(`${key} hu + en`, () => {
      expect(hu, `hu: ${key}`).toContain(`'${key}':`)
      expect(en, `en: ${key}`).toContain(`'${key}':`)
    })
  }

  for (const key of ['cb.card.tabs_none_ctx', 'cb.card.tabs_none_ctx_help']) {
    it(`${key} hu + en`, () => {
      expect(hu, `hu: ${key}`).toContain(`'${key}':`)
      expect(en, `en: ${key}`).toContain(`'${key}':`)
    })
  }

  it('a sugo a KOVETKEZO LEPEST mondja, nem csak a tenyt', () => {
    const line = /'cb\.card\.tabs_none_ctx_help':\s*'([^']*)'/.exec(hu)
    expect(line, 'nincs meg a hu sugo').not.toBeNull()
    expect(line![1]).toMatch(/VS Code/)
  })
})

describe('a kulon kontextus-sor nem ismetli meg a szamot', () => {
  it('a kartya csak akkor rakja ki, ha az ures-ag nem mondta el', () => {
    expect(app).toContain('!cbHasTabRows(e) && !cbTabsEmptyHasCtx(e) ? cbContextRowHtml(e)')
  })
})

// A "NYITVA VAN A PANELEN" ALLAPOT MEGSZUNT -- ES NEM IS TERHET VISSZA.
//
// 2026-08-30-ig itt allt negy teszt, ami azt orizte, hogy a kartya kulon
// mondatot ad a "nyitva, de nem fut" fulnek. A mondat egy MERHETETLEN allitason
// alapult: a nyitottsagot a VS Code `state.vscdb` fajljabol olvastuk, ami erre
// nem alkalmas (Anthropic claude-code#74894 -- "This is NOT a reliable source",
// a valodi lista a bovitmeny MEMORIAJABAN el). Amit nem tudunk megmerni, arrol
// nem allitunk semmit: a `cb.card.tab_open_not_running` kulcspar torolve.
//
// Reszletek es a meres: `code-tabs-vscode-open.test.ts` fejlece.
describe('a "nyitva, de nem fut" allitas nem terhet vissza', () => {
  it('a nem futo ful EGY mondatot kap, es az a merest mondja', () => {
    const html = api.cbTabsPickHtml({
      tabs: [{ sessionId: 'aaaa-bbbb', title: '47-es kanban kartya', live: false, current: true }],
      tabsReason: 'ok',
    })
    expect(html).toContain('cb.card.tab_not_running')
  })

  it('a futo ful nem kap ilyen mondatot', () => {
    const html = api.cbTabsPickHtml({
      tabs: [{ sessionId: 'aaaa-bbbb', title: 'fut', live: true, current: true }],
      tabsReason: 'ok',
    })
    expect(html).not.toContain('cb.card.tab_not_running')
  })

  it('a torolt kulcsok EGYIK nyelvben sem elnek tovabb', () => {
    // Felig eltavolitott szoveg ugyanolyan hiba, mint a felig leforditott.
    for (const key of ['cb.card.tab_open_not_running', 'cb.card.tab_open_not_running_help']) {
      expect(hu, 'ott maradt a magyar kulcs: ' + key).not.toContain("'" + key + "'")
      expect(en, 'ott maradt az angol kulcs: ' + key).not.toContain("'" + key + "'")
    }
    expect(app, 'az app.js meg hivatkozik ra').not.toContain('tab_open_not_running')
  })

  it('a felulet NEM szur masodszor: a szerver csoportjait jeleniti meg', () => {
    // Amikor a kartya sajat feltetellel megismetelte a szerver szuresét, a
    // ket szuro egymas ellen dolgozott -- ez volt az egyik oka annak, hogy a
    // hiba 12 koron at visszajart. Egy meres, egy hely.
    expect(app, 'visszakerult a masodik szuro').not.toContain('vscodeOpen')
  })
})
