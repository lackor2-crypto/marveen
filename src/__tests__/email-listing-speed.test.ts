// Boss, 2026-08-19: "Hiba a levelek betoltesekor. a masodik oszlopnal ezt irta
// ki amikor a kukara kattintottam." -- plus "nezd vegig hogy mennyi a betoltes
// ideje az osszes tobbinel is" es "a level teste betoltesere meg mindig kicsit
// varni kell".
//
// A diagnozis MERT eredmenye, hogy ez a fajl letezik:
//  1. a kozvetlen IMAP-ut MINDEN mappara elhasalt ("imapFlags.filter is not a
//     function"), es CSENDBEN visszaesett a himalaya-ra: listazasonkent uj
//     processz + uj IMAP-bejelentkezes. A Kuka igy 66 mp / HTTP 502 lett.
//  2. a himalaya `--json` a HIBAT is stdoutra irja, es a mi fallback-szovegunk
//     elrejtette -- ezert nem sult el a mar megirt ujraprobalkozas az atmeneti
//     "Resource temporarily unavailable (os error 11)"-re.
//  3. egy uj Gmail-bejelentkezes 9,6 mp; az 5 perces kilakoltatas miatt ezt
//     szinte minden latogatas kifizette.
//  4. a mar cache-elt level teste is 0,6-2,5 mp-et varakozott egy "letezik-e
//     meg?" IMAP-korutra.
// Meres a javitas utan: Kuka 0,44 mp, pflegedienst 12,3 -> 0,38 mp, level test
// hidegen 0,46-0,56 mp / melegen 3-8 ms.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _internal } from '../web/email-imap.js'

const { parseImapFlags } = _internal as unknown as {
  parseImapFlags: (f: Set<string> | string[] | undefined | null) => Array<{ raw: string; iana: string }>
}
const IMAP_SRC = readFileSync(join(__dirname, '..', 'web', 'email-imap.ts'), 'utf-8')
const EMAIL_SRC = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf-8')
const APP_SRC = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')

function blokk(src: string, kezdet: string): string {
  const start = src.indexOf(kezdet)
  expect(start, `nincs ilyen kezdet: ${kezdet}`).toBeGreaterThan(-1)
  // A torzs nyito kapcsos zarojele az elso olyan '{', ami a sor VEGEN all: a
  // szignaturaban levok (tobbsoros visszateresi tipus, destrukturalt parameter)
  // nem azok, es rajuk allva a zarojel-parositas azonnal veget erne.
  const re = /\{\s*$/gm
  re.lastIndex = start
  const m = re.exec(src)
  const nyit = m ? m.index : -1
  expect(nyit, `nem talalom a torzs elejet: ${kezdet}`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = nyit; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`nem zarodik: ${kezdet}`)
}

describe('boritek-flagek: SET is jo, nem csak tomb', () => {
  it('Set-bol is felismeri a flageket -- EZ tortte el minden mappa listazasat', () => {
    // imapflow SET-et ad vissza; a `.filter` hivas ezen dobott, a hivo pedig
    // ezt "nem sikerult"-kent ertelmezte, es a lassu utra ment.
    expect(parseImapFlags(new Set(['\\Seen', '\\Flagged']))).toEqual([
      { raw: '\\Seen', iana: 'seen' },
      { raw: '\\Flagged', iana: 'flagged' },
    ])
  })

  it('tombbel is mukodik (visszafele kompatibilis)', () => {
    expect(parseImapFlags(['\\Seen'])).toEqual([{ raw: '\\Seen', iana: 'seen' }])
  })

  it('hianyzo ertekre ures lista, nem kivetel', () => {
    expect(parseImapFlags(undefined)).toEqual([])
    expect(parseImapFlags(null)).toEqual([])
    expect(parseImapFlags(new Set())).toEqual([])
  })

  it('az ismeretlen flageket kiszuri (pl. Gmail sajat labeljei)', () => {
    expect(parseImapFlags(new Set(['\\Seen', '$Phishing', 'valami']))).toEqual([{ raw: '\\Seen', iana: 'seen' }])
  })
})

describe('szuresmentes listazas: sorszam-sav, nem SEARCH ALL', () => {
  const body = blokk(IMAP_SRC, 'export async function listEnvelopesDirect(')

  it('nem ker le MINDEN UID-ot ahhoz, hogy 50-et hasznaljon', () => {
    // 1122 leveles mappanal ez 1122 UID atvitele volt 50 helyett.
    expect(body.includes('client.mailbox'), 'a SELECT valaszabol jovo exists-t hasznaljuk').toBe(true)
    expect(body.includes('exists - end + 1'), 'a kert oldal sorszam-savja')
      .toBe(true)
  })

  it('kereseshez MEGIS SEARCH kell (ott a talalati halmaz a kerdes)', () => {
    expect(body.includes('buildImapSearchCriteria(searchQuery)')).toBe(true)
    expect(body.includes('client.search(criteria')).toBe(true)
  })

  it('ha a szerver nem adott exists-t, a regi SEARCH-os ut a tartalek', () => {
    expect(body.includes('exists !== null')).toBe(true)
    expect(body.includes('{ all: true }'), 'a tartalek uton marad a SEARCH ALL').toBe(true)
  })

  it('ures mappa ures listat ad, nem "nem sikerult"-ot', () => {
    // null = "essunk vissza a himalaya-ra"; egy ures mappanal ez feleslegesen
    // inditott volna egy uj processzt + IMAP-bejelentkezest.
    expect(body.includes('if (exists === 0 || start >= exists) return []')).toBe(true)
  })
})

describe('IMAP-kapcsolat: eletben tartas, nem ujra-bejelentkezes', () => {
  it('nincs tetlensegi kilakoltatas (egy uj bejelentkezes 9,6 mp volt)', () => {
    expect(IMAP_SRC.includes('IDLE_EVICT_MS')).toBe(false)
    expect(IMAP_SRC.includes('scheduleEviction')).toBe(false)
  })

  it('NOOP-pal tartja eletben, es a halott kapcsolatot kiveszi', () => {
    const body = blokk(IMAP_SRC, 'function scheduleKeepalive(')
    expect(body.includes('.noop()')).toBe(true)
    expect(body.includes('clients.delete(accountId)'), 'halott socket eseten ujra kell jelentkezni').toBe(true)
    expect(body.includes('.unref()')).toBe(true)
  })

  it('egy fiokra egyszerre EGY bejelentkezes fut (parhuzamos hivok osztoznak)', () => {
    const body = blokk(IMAP_SRC, 'async function getClient(')
    expect(body.includes('connecting.get(accountId)')).toBe(true)
    expect(body.includes('connecting.set(accountId')).toBe(true)
  })
})

describe('himalaya hibaszoveg: a stdout-on jovo JSON hibat is latja', () => {
  it('a --json mod stdout-hibajat adja vissza, nem a "Command failed"-et', () => {
    const body = blokk(EMAIL_SRC, 'export function himalayaErrorText(')
    expect(body.includes('JSON.parse(r.stdout)')).toBe(true)
    expect(body.includes('.error')).toBe(true)
    expect(body.includes("return r.stderr || r.stdout || 'himalaya failed'"), 'nem-JSON kimenetnel marad a regi viselkedes').toBe(true)
  })

  it('az atmeneti hibat EZEN a szovegen ismeri fel (kulonben nincs ujraprobalas)', () => {
    const body = blokk(EMAIL_SRC, 'async function himalayaRead(')
    expect(body.includes('isTransientImapError(himalayaErrorText(attempt))')).toBe(true)
    expect(body.includes('isTransientImapError(attempt.stderr || attempt.stdout)'), 'ez a sorrend a fallback-szoveget latta, nem a valodi hibat').toBe(false)
  })

  it('a hibaszoveg-kereses nem probalja beolvasni egy tobb tiz MB-os kimenetet', () => {
    const body = blokk(EMAIL_SRC, 'export function himalayaErrorText(')
    expect(body.includes('64 * 1024')).toBe(true)
  })
})

describe('level teste: a kesz valasz nem var IMAP-korutra', () => {
  const body = blokk(EMAIL_SRC, 'async function readMessageBody(')

  it('a cache-talalat AZONNAL kimegy, a letezes-proba a hatterben fut', () => {
    expect(body.includes('if (await messageStillExists(account, mailbox, id)) {'), 'ez volt a 0,6-2,5 mp').toBe(false)
    expect(body.includes('void (async () => {')).toBe(true)
    expect(body.includes('messageStillExists(account, mailbox, id)')).toBe(true)
  })

  it('ha kiderul, hogy a level mar nincs, a bejegyzes kiesik', () => {
    expect(body.includes('messageBodyCache.delete(cacheKey)')).toBe(true)
  })

  it('halozati zavar nem uriti ki a cache-t (mint korabban sem)', () => {
    expect(body.includes('catch { /* halozati zavar')).toBe(true)
  })
})

describe('masodik oszlop: nem remeg, es nem lancolodik vegtelen ujratoltes', () => {
  const body = blokk(APP_SRC, 'async function loadEmailEnvelopes(')

  it('ugyanannak a nezetnek az ujratoltese nem uriti ki a listat', () => {
    // Ez volt a "tobbszor eltunik par miliszekundumra": minden csendes
    // ujratoltes kiirta a "Betoltes..." helykitoltot a kesz sorok helyere.
    expect(body.includes('const sameEnvelopeView =')).toBe(true)
    expect(body.includes("if (!sameEnvelopeView) pane.innerHTML")).toBe(true)
  })

  it('elhasalt UJRATOLTES nem cserel hibauzenetre mar mukodo listat', () => {
    const hibaSorok = body.split('\n').filter(l => l.includes("t('email.envelopes_load_error')"))
    expect(hibaSorok.length, 'ket helyen jelenhet meg hiba: keres-hiba es nem-tomb valasz').toBe(2)
    for (const sor of hibaSorok) expect(sor.includes('!sameEnvelopeView')).toBe(true)
  })

  it('a mappa-oszlop ugyanigy vedve van', () => {
    const mb = blokk(APP_SRC, 'async function loadEmailMailboxes(')
    expect(mb.includes('const sameMailboxView =')).toBe(true)
    expect(mb.includes('if (!sameMailboxView) pane.innerHTML')).toBe(true)
  })

  it('egy nezet legfeljebb 30 masodpercenkent tolthet ujra magatol', () => {
    const gate = blokk(APP_SRC, 'function emailScheduleStaleReload(')
    expect(gate.includes('EMAIL_STALE_RELOAD_MIN_GAP_MS')).toBe(true)
    expect(gate.includes('emailStaleReloadLast')).toBe(true)
    expect(APP_SRC.includes('const EMAIL_STALE_RELOAD_MIN_GAP_MS = 30000')).toBe(true)
  })

  it('minden ujratoltes-idozitesnek van SAJAT kulcsa (kulonben egymast fojtanak)', () => {
    expect(APP_SRC.includes('mailboxes::$')).toBe(true)
    expect(APP_SRC.includes('envelopes::$')).toBe(true)
  })
})

describe('elore-melegites: az elso 20 level teste, de sose a Boss ele', () => {
  const body = blokk(APP_SRC, 'async function emailPrewarmBodies(')

  it('az elso 20 levelre fut', () => {
    expect(APP_SRC.includes('const EMAIL_PREWARM_COUNT = 20')).toBe(true)
    expect(body.includes('entries.slice(0, EMAIL_PREWARM_COUNT)')).toBe(true)
  })

  it('egyszerre egyet ker le (megvarja a valaszt)', () => {
    expect(body.includes('await emailPrefetchBody(entry.id, entry.mailbox, { wait: true })')).toBe(true)
  })

  it('megall, amig a felhasznalo sajat kerese fut', () => {
    expect(body.includes('while (emailUserFetchBusy > 0)')).toBe(true)
    const olvas = blokk(APP_SRC, 'async function loadEmailMessage(')
    expect(olvas.includes('emailUserFetchBusy++')).toBe(true)
    expect(olvas.includes('emailUserFetchBusy--')).toBe(true)
    expect(olvas.includes('} finally {'), 'hiba eseten sem ragadhat be a szamlalo').toBe(true)
  })

  it('nezetvaltasnal (mas mappa/fiok) azonnal leall', () => {
    expect(body.includes('emailEnvelopeViewKey() !== viewKey')).toBe(true)
    expect(body.includes('token !== emailPrewarmToken')).toBe(true)
  })

  it('a lebegtetes ugyanezt a melegitest hasznalja, levelenkent egyszer', () => {
    const hover = blokk(APP_SRC, 'function emailAttachHoverPrefetch(')
    expect(hover.includes('mouseenter')).toBe(true)
    expect(hover.includes('mouseleave'), 'ha a kurzor elhagyja a sort, ne induljon el').toBe(true)
    const pre = blokk(APP_SRC, 'function emailPrefetchBody(')
    expect(pre.includes('emailBodyPrefetched.has(key)')).toBe(true)
    expect(pre.includes('emailBodyPrefetched.delete(key)'), 'hiba utan a valodi kattintas ujra megprobalhassa').toBe(true)
  })

  it('a melleklet TARTALMAT nem tolti elore (akar tobb tiz MB)', () => {
    expect(body.includes('/api/email/attachment')).toBe(false)
  })
})
