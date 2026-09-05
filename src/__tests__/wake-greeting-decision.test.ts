// Kanban #202 (231cb999): a felebredeskori koszones FELTETELES.
//
// Boss eszrevetele (2026-09-02 01:21): kuldott ket uzenetet, es a valasz elott
// lefutott egy SessionStart hook -- amitol a #106 szabalya szerint kotelezo volt
// koszonessel kezdeni, holott az o szemszogebol a beszelgetes egy pillanatra sem
// szakadt meg. Amit ez a teszt ved:
//   1. friss, valaszra varo uzenet -> NINCS koszones (ez maga a bejelentett hiba),
//   2. regota valasz nelkul allo uzenet -> VAN koszones (a #106 eletjele megmarad),
//   3. a nem-mert allapot (ures vagy olvashatatlan naplo) SOSE nemit el koszonest,
//      es a ketto KULON okot kap ("a nulla ket dolgot jelenthet"),
//   4. az injektalt szoveg es a CLAUDE.md-be irt kivetel UGYANARRA a jelolore
//      hivatkozik -- kulonben az agens nem tudja osszekotni a kettot.
import { describe, expect, it } from 'vitest'
import {
  decideWakeGreeting,
  buildWakeGreetingContext,
  composeSessionStartContext,
  GREETING_OUTAGE_AFTER_MS,
  type ConversationEdge,
} from '../wake-greeting.js'

const NOW = 1_788_600_000_000 // rogzitett ora: a dontes sose fuggjon a futas idejetol

function edge(over: Partial<ConversationEdge> = {}): ConversationEdge {
  return { lastInboundAt: NOW, answered: false, inboundRows: 1, readable: true, ...over }
}

describe('decideWakeGreeting #202', () => {
  it('a tulajdonos EPP MOST irt es meg valaszra var -> NINCS koszones', () => {
    const d = decideWakeGreeting(edge({ lastInboundAt: NOW - 5 * 60_000 }), NOW)
    expect(d.verdict).toBe('folyamatos')
    expect(d.greet).toBe(false)
    expect(d.waitedMs).toBe(5 * 60_000)
  })

  it('regota valasz nelkul allo uzenet -> VALODI kieses, koszonj', () => {
    const d = decideWakeGreeting(edge({ lastInboundAt: NOW - 45 * 60_000 }), NOW)
    expect(d.verdict).toBe('kieses')
    expect(d.greet).toBe(true)
    expect(d.waitedMs).toBe(45 * 60_000)
  })

  it('pontosan a kuszobon mar kieses (a hatar bennfoglalo)', () => {
    const d = decideWakeGreeting(edge({ lastInboundAt: NOW - GREETING_OUTAGE_AFTER_MS }), NOW)
    expect(d.verdict).toBe('kieses')
    // egy ezredmasodperccel alatta viszont meg nem
    const d2 = decideWakeGreeting(edge({ lastInboundAt: NOW - GREETING_OUTAGE_AFTER_MS + 1 }), NOW)
    expect(d2.verdict).toBe('folyamatos')
  })

  it('a kuszob felulirhato (a spec "hosszabb ideig"-je egy szam, nem szokas)', () => {
    const e = edge({ lastInboundAt: NOW - 10 * 60_000 })
    expect(decideWakeGreeting(e, NOW, { thresholdMs: 5 * 60_000 }).verdict).toBe('kieses')
    expect(decideWakeGreeting(e, NOW, { thresholdMs: 60 * 60_000 }).verdict).toBe('folyamatos')
  })

  it('csendes csatorna (nincs valaszra varo uzenet) -> alapbol KOSZON (#106 valtozatlan)', () => {
    const d = decideWakeGreeting(edge({ answered: true, lastInboundAt: NOW - 8 * 3600_000 }), NOW)
    expect(d.verdict).toBe('csend')
    expect(d.greet).toBe(true)
    expect(d.waitedMs).toBeNull()
    // ...de a politika egy kapcsolo, nem beegetett szokas
    expect(decideWakeGreeting(edge({ answered: true }), NOW, { greetOnQuiet: false }).greet).toBe(false)
  })

  it('URES naplo != "nem volt kieses": nem_tudom, es a koszones marad', () => {
    const d = decideWakeGreeting(edge({ inboundRows: 0, lastInboundAt: null }), NOW)
    expect(d.verdict).toBe('nem_tudom')
    expect(d.greet).toBe(true)
    expect(d.reason).toBe('nincs-bejovo-naplo')
  })

  it('OLVASHATATLAN naplo kulon okot kap (a nulla ket dolgot jelenthet)', () => {
    const d = decideWakeGreeting(edge({ readable: false }), NOW)
    expect(d.verdict).toBe('nem_tudom')
    expect(d.greet).toBe(true)
    expect(d.reason).toBe('ledger-olvashatatlan')
    // A ket nem-mert eset NEM mosodhat ossze egyetlen okba.
    expect(d.reason).not.toBe(decideWakeGreeting(edge({ inboundRows: 0 }), NOW).reason)
  })

  it('jovobeli idobelyeg (elallitott ora) -> nem talalgat, a biztonsagos ag megy', () => {
    const d = decideWakeGreeting(edge({ lastInboundAt: NOW + 60_000 }), NOW)
    expect(d.verdict).toBe('nem_tudom')
    expect(d.greet).toBe(true)
    expect(d.reason).toBe('ora-elorement')
  })

  it('friss telepites: ures, olvashato naplo eseten a viselkedes VALTOZATLAN', () => {
    // Egy most telepitett Marveenben egyetlen sor sincs a ledgerben. Ha ez
    // elnemitana a koszonest, a #202 csendben eltorne a #106-ot mindenkinel.
    const d = decideWakeGreeting({ lastInboundAt: null, answered: false, inboundRows: 0, readable: true }, NOW)
    expect(d.greet).toBe(true)
    expect(buildWakeGreetingContext(d)).toBeNull()
  })
})

describe('buildWakeGreetingContext #202', () => {
  it('csak a MERT agakon beszel (csend/nem_tudom eseten hallgat)', () => {
    expect(buildWakeGreetingContext(decideWakeGreeting(edge({ answered: true }), NOW))).toBeNull()
    expect(buildWakeGreetingContext(decideWakeGreeting(edge({ readable: false }), NOW))).toBeNull()
  })

  it('a "ne koszonj" szoveg megmondja a percet es a tiltast', () => {
    const txt = buildWakeGreetingContext(decideWakeGreeting(edge({ lastInboundAt: NOW - 7 * 60_000 }), NOW))
    expect(txt).toContain('EBREDES-KOSZONES')
    expect(txt).toContain('NE koszonj')
    expect(txt).toContain('7 perce')
  })

  it('a "koszonj" szoveg a varakozas hosszat mondja meg', () => {
    const txt = buildWakeGreetingContext(decideWakeGreeting(edge({ lastInboundAt: NOW - 90 * 60_000 }), NOW))
    expect(txt).toContain('EBREDES-KOSZONES')
    expect(txt).toContain('Szia, itt vagyok, felebredtem')
    expect(txt).toContain('90 perce')
  })

  it('gepfuggetlen: nincs benne nev, ut, agens-azonosito', () => {
    for (const ms of [3 * 60_000, 99 * 60_000]) {
      const txt = buildWakeGreetingContext(decideWakeGreeting(edge({ lastInboundAt: NOW - ms }), NOW)) ?? ''
      expect(txt).not.toContain('/home/')
      expect(txt).not.toContain('lackor')
      expect(txt).not.toContain('Marvin')
      expect(txt).not.toContain('Boss')
    }
  })
})

describe('composeSessionStartContext #202', () => {
  it('a koszones a fuggo munka ELE kerul', () => {
    const out = composeSessionStartContext('KOSZONES', 'FUGGO')
    expect(out).toBe('KOSZONES\n\nFUGGO')
  })

  it('barmelyik hianyozhat, es ha mindketto hianyzik, a hook hallgat', () => {
    expect(composeSessionStartContext('KOSZONES', null)).toBe('KOSZONES')
    expect(composeSessionStartContext(null, 'FUGGO')).toBe('FUGGO')
    expect(composeSessionStartContext(null, null)).toBeNull()
    expect(composeSessionStartContext('   ', null)).toBeNull()
  })
})

// A ket veg kulon zold lehet ugy, hogy a szal koztuk elszakadt: a fenti blokkok
// a DONTEST merik, ez pedig azt, hogy a MERES tenyleg azt hozza a ledgerbol,
// amire a dontes epul (masodperc->ezredmasodperc valtas, az azonos masodpercen
// belüli sorrend, es a bejovo sorok szama). A sorokat ugyanugy szurjuk be, ahogy
// a python ledger-hook teszi -- ezert egy VALODI (temp) adatbazis, nem :memory:.
describe('getConversationEdge (a ledger-olvasas maga)', () => {
  it('a valos tabla-alakon a helyes elt adja', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { default: Database } = await import('better-sqlite3')
    const { initDatabase, getConversationEdge } = await import('../db.js')

    const dir = mkdtempSync(join(tmpdir(), 'wake-greeting-ledger-'))
    const file = join(dir, 'probe.db')
    try {
      initDatabase(file)
      const raw = new Database(file)
      const ins = raw.prepare(
        `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )

      // Ures naplo: nulla bejovo sor -> a hivo "nem latok oda"-kent kezeli.
      expect(getConversationEdge('a1')).toEqual({ lastInboundAt: null, oldestUnansweredAt: null, answered: false, inboundRows: 0 })

      ins.run('a1', 'c', 'in', '1', 'regi kerdes', '2026-01-01T00:00:00Z', 1000)
      ins.run('a1', 'c', 'out', null, 'valasz', '2026-01-01T00:00:10Z', 1010)
      expect(getConversationEdge('a1')).toEqual({ lastInboundAt: 1000 * 1000, oldestUnansweredAt: null, answered: true, inboundRows: 1 })

      // Uj kerdes a valasz utan -> nyitott.
      ins.run('a1', 'c', 'in', '2', 'uj kerdes', '2026-01-01T00:00:20Z', 1020)
      expect(getConversationEdge('a1')).toEqual({ lastInboundAt: 1020 * 1000, oldestUnansweredAt: 1020 * 1000, answered: false, inboundRows: 2 })

      // UGYANABBAN a masodpercben erkezo valasz: az id dont (ugyanaz a szabaly,
      // amit a ledger_lib.open_question hasznal) -- kulonben egy gyors valasz
      // "megvalaszolatlan"-nak latszana, es feleslegesen koszonnenk.
      ins.run('a1', 'c', 'out', null, 'gyors valasz', '2026-01-01T00:00:20Z', 1020)
      expect(getConversationEdge('a1').answered).toBe(true)

      // Mas agens naploja SOSE keveredik ide.
      expect(getConversationEdge('a2')).toEqual({ lastInboundAt: null, oldestUnansweredAt: null, answered: false, inboundRows: 0 })
      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
