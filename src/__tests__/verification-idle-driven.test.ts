// Kanban 2a32b51e, second half. Boss, 2026-08-28 (Telegram 4412):
// "10 perc az sok. sokat kel varni. mi van ha 1 perc alatt megcsinal valamit
//  az agent? akkor meg var 9 percig? feleslegesen? figyelni kellene hogy
//  milyen statuszban van, es ha varakozoban, akkor mehet neki a kovetkezo!"
//
// The reminder used to run on a clock alone: 10 minutes to the first nudge,
// plus up to a 2-minute sweep tick = 12 minutes of silence for an agent that
// finished in one and then sat idle. These lock in the state-driven schedule,
// and -- just as important -- the three states, because "I could not read the
// pane" must never be filed as "it is working".
import { describe, it, expect, beforeEach } from 'vitest'
import {
  runVerificationSweep,
  reminderSchedule,
  VERIFICATION_REMINDER_MS,
  VERIFICATION_REMINDER_REPEAT_MS,
  VERIFICATION_IDLE_GRACE_MS,
  VERIFICATION_IDLE_BACKOFF_MS,
  VERIFICATION_MAX_REMINDERS,
  VERIFICATION_SCAN_FROM_MS,
  type AgentActivity,
  type VerificationSweepDeps,
} from '../approval-verification-sweep.js'
import {
  initDatabase, createApproval, createOrResetApprovalVerification,
  listPendingVerificationsOlderThan, markVerificationReminded, markVerificationNoResponse,
  listApprovalVerifications, getDb,
} from '../db.js'
import type { ApprovalVerification } from '../db.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const NOW = 1_800_000_000_000

function row(over: Partial<ApprovalVerification> & { ageMs: number }): ApprovalVerification {
  const { ageMs, ...rest } = over
  return {
    id: 'a1:gemma', approval_id: 'a1', agent: 'gemma', status: 'pending',
    mode: 'verify', report: null,
    requested_at: Math.floor((NOW - ageMs) / 1000),
    resolved_at: null, reminded_at: null, reminder_count: 0,
    ...rest,
  }
}

async function harness(rows: ApprovalVerification[], over: Partial<VerificationSweepDeps> = {}) {
  const reminders: string[] = []
  const probes: string[] = []
  const deps: VerificationSweepDeps = {
    now: NOW,
    listPendingOlderThan: (cutoffSec) => rows.filter(r => r.status === 'pending' && r.requested_at <= cutoffSec),
    agentExists: () => true,
    sendReminder: (r) => { reminders.push(r.agent); return true },
    markReminded: (id, atSec, notSinceSec) => {
      const t = rows.find(r => r.id === id)
      if (!t || t.status !== 'pending') return false
      if (t.reminded_at != null && t.reminded_at > notSinceSec) return false
      t.reminded_at = atSec
      t.reminder_count += 1
      return true
    },
    markNoResponse: () => true,
    probeActivity: async (agent) => { probes.push(agent); return 'idle' },
    hasUndeliveredMessage: () => false,
    ...over,
  }
  return { result: await runVerificationSweep(deps), reminders, probes }
}

describe('reminderSchedule: az allapot dönti el az utemet, nem az ora', () => {
  it('tetlen agens elso emlekeztetoje a rovid alsohatar utan mehet, nem 10 perc mulva', () => {
    const s = reminderSchedule('idle', 0)
    expect(s.minAgeMs).toBe(VERIFICATION_IDLE_GRACE_MS)
    expect(s.minAgeMs).toBeLessThan(VERIFICATION_REMINDER_MS)
  })

  it('dolgozo agens a regi tizperces utemet kapja -- ot nem noszogatjuk', () => {
    const s = reminderSchedule('busy', 0)
    expect(s.minAgeMs).toBe(VERIFICATION_REMINDER_MS)
    expect(s.gapMs).toBe(VERIFICATION_REMINDER_REPEAT_MS)
  })

  it('"nem lattam oda" NEM gyorsit -- de nem is ugyanaz, mint a "dolgozik"', () => {
    // Ugyanaz az utemterv, mert nem szabad talalgatni; a KULONBSEG a naploban
    // es a result.unreadable listaban latszik (lejjebb).
    expect(reminderSchedule('unknown', 0)).toEqual(reminderSchedule('busy', 0))
  })

  it('a tetlen utem szunetei NONEK, es a vegen beallnak az utolsora', () => {
    const gaps = [0, 1, 2, 3, 9].map(n => reminderSchedule('idle', n).gapMs)
    expect(gaps.slice(0, 3)).toEqual([...VERIFICATION_IDLE_BACKOFF_MS])
    const last = VERIFICATION_IDLE_BACKOFF_MS[VERIFICATION_IDLE_BACKOFF_MS.length - 1]
    expect(gaps[3]).toBe(last)
    expect(gaps[4]).toBe(last)
    // Novekvo, nem valtozatlan: enelkul egy tetlen, de nema agens negy oran at
    // masfel percenkent kapna uzenetet.
    expect(VERIFICATION_IDLE_BACKOFF_MS[1]!).toBeGreaterThan(VERIFICATION_IDLE_BACKOFF_MS[0]!)
    expect(VERIFICATION_IDLE_BACKOFF_MS[2]!).toBeGreaterThan(VERIFICATION_IDLE_BACKOFF_MS[1]!)
  })
})

describe('a sopres a tetlen agenst gyorsan eleri', () => {
  it('BOSS ESETE: egy perc alatt vegzo, tetlen agens nem var tizenket percet', () => {
    // Ha ez a teszt elbukik, az azt jelenti, hogy visszaallt az ora-alapu utem.
    expect(VERIFICATION_IDLE_GRACE_MS).toBeLessThanOrEqual(2 * 60 * 1000)
  })

  it('tetlen agens a rovid alsohatar utan kap emlekeztetot', async () => {
    const { reminders } = await harness([row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })])
    expect(reminders).toEqual(['gemma'])
  })

  it('...de a kegyelmi idon belul meg nem -- egy epp indulo fordulot nem zavarunk', async () => {
    const { reminders } = await harness([row({ ageMs: VERIFICATION_IDLE_GRACE_MS - 1000 })])
    expect(reminders).toEqual([])
  })

  it('ugyanez az agens DOLGOZVA meg nem kap semmit ennyi ido utan', async () => {
    const { reminders } = await harness(
      [row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })],
      { probeActivity: async () => 'busy' },
    )
    expect(reminders).toEqual([])
  })

  it('a lekerdezes vagasa a rovid alsohatarhoz igazodik, kulonben a fiatal sor be sem kerulne', async () => {
    expect(VERIFICATION_SCAN_FROM_MS).toBe(VERIFICATION_IDLE_GRACE_MS)
    let cutoffSeen = 0
    await harness([row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })], {
      listPendingOlderThan: (c) => { cutoffSeen = c; return [] },
    })
    expect(NOW / 1000 - cutoffSeen).toBeCloseTo(VERIFICATION_IDLE_GRACE_MS / 1000, 0)
  })
})

describe('spam-vedelem: eskalacio es a mar sorban allo uzenet', () => {
  it('nem tesz be masodik uzenetet, ha az elso meg kezbesitetlen', async () => {
    const { reminders, probes } = await harness(
      [row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })],
      { hasUndeliveredMessage: () => true },
    )
    expect(reminders).toEqual([])
    // Es meg csak pane-t sem olvasunk hozza: az olcso kizaras eloszor.
    expect(probes).toEqual([])
  })

  it('a nudge-keret kimeritese utan elhallgat -- a hatarido zarja le a sort', async () => {
    const { reminders, probes } = await harness([row({
      ageMs: VERIFICATION_IDLE_GRACE_MS + 10 * 60 * 1000,
      reminder_count: VERIFICATION_MAX_REMINDERS,
      reminded_at: Math.floor((NOW - 60 * 60 * 1000) / 1000),
    })])
    expect(reminders).toEqual([])
    expect(probes).toEqual([])
  })

  it('a keret alatt meg szol', async () => {
    const { reminders } = await harness([row({
      ageMs: VERIFICATION_IDLE_GRACE_MS + 10 * 60 * 1000,
      reminder_count: VERIFICATION_MAX_REMINDERS - 1,
      reminded_at: Math.floor((NOW - 60 * 60 * 1000) / 1000),
    })])
    expect(reminders).toEqual(['gemma'])
  })

  it('egy tetlen, nema agens negy ora alatt is csak a keretnyi uzenetet kapja', async () => {
    // Vegigjatsszuk a teljes hataridot, egy percenkent lepve. A regi utemterv
    // szerint ez ~24 nudge lett volna; a gyors utem onmagaban tobb szazat.
    const r = row({ ageMs: VERIFICATION_IDLE_GRACE_MS })
    const rows = [r]
    const reminders: string[] = []
    const base: Omit<VerificationSweepDeps, 'now'> = {
      listPendingOlderThan: (c) => rows.filter(x => x.status === 'pending' && x.requested_at <= c),
      agentExists: () => true,
      sendReminder: (x) => { reminders.push(x.agent); return true },
      markReminded: (id, atSec, notSinceSec) => {
        const t = rows.find(x => x.id === id)!
        if (t.reminded_at != null && t.reminded_at > notSinceSec) return false
        t.reminded_at = atSec; t.reminder_count += 1; return true
      },
      markNoResponse: () => true,
      probeActivity: async () => 'idle',
      hasUndeliveredMessage: () => false,
    }
    for (let t = 0; t < 4 * 60; t++) {
      await runVerificationSweep({ ...base, now: NOW + t * 60 * 1000 })
    }
    expect(reminders.length).toBe(VERIFICATION_MAX_REMINDERS)
  })
})

describe('a nulla ket dolgot jelenthet: az olvashatatlan allapot kulon latszik', () => {
  it('az unknown sor bekerul a result.unreadable-be, hogy a hivo naplozhassa', async () => {
    const { result, reminders } = await harness(
      [row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })],
      { probeActivity: async () => 'unknown' },
    )
    expect(result.unreadable).toEqual(['a1:gemma'])
    // Es nem gyorsitunk rajta: ennyi ido utan a lassu utem szerint meg nincs nudge.
    expect(reminders).toEqual([])
  })

  it('a dolgozo agens NEM kerul az unreadable listara -- rola tudjuk, mit csinal', async () => {
    const { result } = await harness(
      [row({ ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 })],
      { probeActivity: async () => 'busy' },
    )
    expect(result.unreadable).toEqual([])
  })

  it('az olvashatatlan agens a lassu utem szerint azert kap emlekeztetot', async () => {
    const { reminders } = await harness(
      [row({ ageMs: VERIFICATION_REMINDER_MS + 1000 })],
      { probeActivity: async () => 'unknown' },
    )
    expect(reminders).toEqual(['gemma'])
  })
})

describe('a pane-olvasas ara: agensenkent egyszer, es ures tablanal egyaltalan nem', () => {
  it('ugyanazt az agenst egy fordulon belul csak egyszer kerdezzuk meg', async () => {
    const rows = [
      row({ id: 'a1:gemma', approval_id: 'a1', ageMs: VERIFICATION_IDLE_GRACE_MS + 1000 }),
      row({ id: 'a2:gemma', approval_id: 'a2', ageMs: VERIFICATION_IDLE_GRACE_MS + 2000 }),
      row({ id: 'a3:gemma', approval_id: 'a3', ageMs: VERIFICATION_IDLE_GRACE_MS + 3000 }),
    ]
    const { probes } = await harness(rows)
    expect(probes).toEqual(['gemma'])
  })

  it('FRISS TELEPITES: nincs fuggo sor -> egyetlen pane-olvasas sem tortenik', async () => {
    const { probes, result } = await harness([])
    expect(probes).toEqual([])
    expect(result).toEqual({ reminded: [], expired: [], unreadable: [] })
  })
})

describe('valodi adatbazissal: a szamlalo es a visszaallitas', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createApproval({ id: 'a1', agent_id: 'lackor2-bot', category: 'code_change', action_description: 'X' })
  })

  it('minden kikuldott emlekezteto novel egyet a szamlalon', () => {
    const r = createOrResetApprovalVerification('a1', 'gemma')
    expect(r.reminder_count).toBe(0)
    const t = Math.floor(Date.now() / 1000)
    markVerificationReminded(r.id, t, t - 600)
    expect(listApprovalVerifications('a1')[0]!.reminder_count).toBe(1)
    markVerificationReminded(r.id, t + 601, t + 1)
    expect(listApprovalVerifications('a1')[0]!.reminder_count).toBe(2)
  })

  it('az elutasitott jeloles NEM novel -- kulonben a keret ures fordulokon fogyna el', () => {
    const r = createOrResetApprovalVerification('a1', 'gemma')
    const t = Math.floor(Date.now() / 1000)
    markVerificationReminded(r.id, t, t - 600)
    expect(markVerificationReminded(r.id, t + 1, t - 600)).toBe(false)
    expect(listApprovalVerifications('a1')[0]!.reminder_count).toBe(1)
  })

  it('ujra kiosztaskor a szamlalo nullazodik -- az uj feladat uj keretet kap', () => {
    const r = createOrResetApprovalVerification('a1', 'gemma')
    const t = Math.floor(Date.now() / 1000)
    for (let i = 0; i < VERIFICATION_MAX_REMINDERS; i++) {
      markVerificationReminded(r.id, t + i * 3600, t + i * 3600 - 1)
    }
    expect(listApprovalVerifications('a1')[0]!.reminder_count).toBe(VERIFICATION_MAX_REMINDERS)
    const again = createOrResetApprovalVerification('a1', 'gemma', 'fix')
    expect(again.reminder_count).toBe(0)
    const stored = listApprovalVerifications('a1')[0]!
    expect(stored.reminder_count).toBe(0)
    expect(stored.reminded_at).toBeNull()
  })

  it('a rovid alsohatarnal a friss sor MAR benne van a lekerdezesben', () => {
    const r = createOrResetApprovalVerification('a1', 'gemma')
    getDb().prepare('UPDATE approval_verifications SET requested_at = ? WHERE id = ?')
      .run(Math.floor((Date.now() - (VERIFICATION_IDLE_GRACE_MS + 5000)) / 1000), r.id)
    const cutoff = Math.floor((Date.now() - VERIFICATION_SCAN_FROM_MS) / 1000)
    expect(listPendingVerificationsOlderThan(cutoff).map(x => x.id)).toEqual([r.id])
    // A regi vagassal ugyanez a sor meg nem lett volna benne -- ez volt a 12 perc.
    const oldCutoff = Math.floor((Date.now() - VERIFICATION_REMINDER_MS) / 1000)
    expect(listPendingVerificationsOlderThan(oldCutoff)).toEqual([])
  })

  it('vegigjatszva valodi tarolon: a tetlen agens masodperceken belul kap, nem 12 perc mulva', async () => {
    const r = createOrResetApprovalVerification('a1', 'gemma')
    const dispatchedMs = Date.now()
    getDb().prepare('UPDATE approval_verifications SET requested_at = ? WHERE id = ?')
      .run(Math.floor(dispatchedMs / 1000), r.id)
    const sent: string[] = []
    const sweepAt = (nowMs: number, activity: AgentActivity) => runVerificationSweep({
      now: nowMs,
      listPendingOlderThan: listPendingVerificationsOlderThan,
      agentExists: () => true,
      sendReminder: (x) => { sent.push(x.agent); return true },
      markReminded: markVerificationReminded,
      markNoResponse: markVerificationNoResponse,
      probeActivity: async () => activity,
      hasUndeliveredMessage: () => false,
    })
    // Egy perccel kesobb meg dolgozik: semmi.
    await sweepAt(dispatchedMs + 60_000, 'busy')
    expect(sent).toEqual([])
    // Vegzett es tetlen: a kegyelmi ido utani elso sopresen mar szolunk.
    await sweepAt(dispatchedMs + VERIFICATION_IDLE_GRACE_MS + 1000, 'idle')
    expect(sent).toEqual(['gemma'])
    expect(listApprovalVerifications('a1')[0]!.reminder_count).toBe(1)
  })
})

// A sopres ideje a masik fele ugyanannak a szamnak: hiaba mehet az emlekezteto
// 90 masodperc utan, ha a timer csak ket percenkent ut. A job fajlt szovegkent
// olvassuk, mert az importja tmux-ot es a fel dashboardot huzna be egy olyan
// tesztbe, aminek egyetlen szamra van szuksege.
describe('a timer utemet is a rovid alsohatarhoz kell merni', () => {
  it('a sopres surubben ut, mint a tetlen agens kegyelmi ideje', () => {
    const src = readFileSync(join(process.cwd(), 'src/web/verification-sweep-job.ts'), 'utf8')
    const m = /VERIFICATION_SWEEP_INTERVAL_MS = ([0-9*\s]+)$/m.exec(src)
    expect(m).not.toBeNull()
    const intervalMs = m![1]!.split('*').map(x => Number(x.trim())).reduce((a, b) => a * b, 1)
    expect(Number.isFinite(intervalMs)).toBe(true)
    expect(intervalMs).toBeGreaterThan(0)
    // Enelkul a "tetlenne valas utan legfeljebb egy perccel" igeret nem all:
    // a regi 2 perces tick onmagaban tobb volt, mint a teljes kegyelmi ido.
    expect(intervalMs).toBeLessThanOrEqual(VERIFICATION_IDLE_GRACE_MS)
    expect(intervalMs).toBeLessThanOrEqual(60 * 1000)
  })
})
