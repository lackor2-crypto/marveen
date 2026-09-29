// #402: a Munkapad fiok-sorrendje. CSAK az 5 oras keret szamit, a heti nem.
import { describe, it, expect, afterEach } from 'vitest'
import { workbenchAccounts, workbenchAccountStatuses, isKnownWorkbenchAccount, setWorkbenchAccountListerForTest, noteLimitAnswer, limitResetMatches, resetObservedLimitsForTest, setLiveOverlayForTest, resetLiveOverlayForTest } from '../workbench-agent/accounts.js'

const now = Date.now()
const acc = (agent: string, five: number | null, seven: number | null, model = 'claude-opus-5-5') =>
  ({ agent, configDir: `/cfg/${agent}`, model, fiveHourPct: five, sevenDayPct: seven, usageAt: now })

afterEach(() => { setWorkbenchAccountListerForTest(null); resetObservedLimitsForTest(); resetLiveOverlayForTest() })

describe('workbenchAccounts', () => {
  it('a legtobb 5 oras kerettel rendelkezo elol; a heti 100% NEM szur ki, de a sor vegere kerul', () => {
    setWorkbenchAccountListerForTest(() => [acc('a', 60, 10), acc('b', 5, 100), acc('c', 30, 50)])
    expect(workbenchAccounts(now)).toEqual(['c', 'a', 'b'])
  })

  it('#434: a 0%-os 5 oras, de heti limites fiok nem elozi meg a zold fiokokat', () => {
    setWorkbenchAccountListerForTest(() => [acc('fo', 0, 100), acc('u', 4, 48), acc('l', 14, 2)])
    expect(workbenchAccounts(now)).toEqual(['u', 'l', 'fo'])
  })

  it('elavult heti meres nem sorol hatra', () => {
    const old = { ...acc('b', 5, 100), usageAt: now - 7 * 24 * 3600 * 1000 }
    setWorkbenchAccountListerForTest(() => [acc('a', 60, 10), old])
    expect(workbenchAccounts(now)).toEqual(['b', 'a'])
  })

  it('a kritikus 5 oras keretu fiok kimarad', () => {
    setWorkbenchAccountListerForTest(() => [acc('a', 99, 0), acc('b', 10, 0)])
    expect(workbenchAccounts(now)).toEqual(['b'])
  })

  it('a meretlen keretu fiok a mert fiokok MOGE kerul, nem ele', () => {
    setWorkbenchAccountListerForTest(() => [acc('meretlen', null, null), acc('mert', 40, 0)])
    expect(workbenchAccounts(now)).toEqual(['mert', 'meretlen'])
  })

  it('a lista-hiba nem dob: ures lista', () => {
    setWorkbenchAccountListerForTest(() => { throw new Error('x') })
    expect(workbenchAccounts(now)).toEqual([])
  })
})

// #426: a valaszto-lista MINDEN fiokot mutat, elo allapottal (zold/piros/szurke).
describe('workbenchAccountStatuses', () => {
  it('online / limited (heti 100% VAGY 5 oras kritikus) / unknown (nincs meres)', () => {
    setWorkbenchAccountListerForTest(() => [
      acc('online5h', 20, 10),
      acc('weeklydead', 0, 100),
      acc('fivecrit', 98, 0),
      acc('nomeasure', null, null),
    ])
    const byId: Record<string, string> = {}
    for (const r of workbenchAccountStatuses()) byId[r.agent] = r.status
    expect(byId).toEqual({ online5h: 'online', weeklydead: 'limited', fivecrit: 'limited', nomeasure: 'unknown' })
  })

  it('az ELO (zold) fiokok elol, a limitelt hatul -- de EGY sem esik ki', () => {
    setWorkbenchAccountListerForTest(() => [acc('dead', 0, 100), acc('live', 50, 0)])
    expect(workbenchAccountStatuses().map((r) => r.agent)).toEqual(['live', 'dead'])
    expect(workbenchAccountStatuses().length).toBe(2)
  })

  it('CSAK Claude-fiok: a nem-Claude (ingyenes glm/laguna/nemotron) modell kimarad', () => {
    setWorkbenchAccountListerForTest(() => [
      acc('claude', 20, 0, 'claude-opus-5-5'),
      acc('glm', 10, 0, 'z-ai/glm-5v-turbo'),
      acc('laguna', 5, 0, 'poolside/laguna-xs-2.1:free'),
    ])
    expect(workbenchAccountStatuses().map((r) => r.agent)).toEqual(['claude'])
    expect(isKnownWorkbenchAccount('glm')).toBe(false)
  })

  it('isKnownWorkbenchAccount: csak a valos fiok igaz', () => {
    setWorkbenchAccountListerForTest(() => [acc('valodi', 10, 0)])
    expect(isKnownWorkbenchAccount('valodi')).toBe(true)
    expect(isKnownWorkbenchAccount('elgepelt')).toBe(false)
  })

  it('a lista-hiba nem dob: ures lista', () => {
    setWorkbenchAccountListerForTest(() => { throw new Error('x') })
    expect(workbenchAccountStatuses()).toEqual([])
  })
})

describe('#434: a Claude sajat limit-mondata pirosra allitja a fiokot (Boss, 2026-09-29)', () => {
  // Merve 2026-09-29: a kod-hid 02:11-kor "session limit · resets 3:10am"-et irt,
  // az usalackor 5 oras ablaka 03:10-kor jar le (1790644200000), a statusline
  // viszont 01:45 ota 83%-ot mutatott -- a valaszto zold maradt.
  const t0211 = Date.parse('2026-09-29T00:11:18Z')
  const usa = { ...acc('usalackor', 83, 55), usageAt: Date.parse('2026-09-28T23:45:11Z'), fiveHourResetsAt: 1790644200000, sevenDayResetsAt: 1790877600000 }
  const l3 = { ...acc('lackor3', 16, 7), usageAt: t0211, fiveHourResetsAt: 1790658000000, sevenDayResetsAt: 1791226800000 }
  const sentence = "Claude Code reported an error You've hit your session limit · resets 3:10am (Europe/Budapest)"

  it('a lejarati ido alapjan a kod-hid limitje az EGYETLEN illeszkedo fiokhoz kotodik', () => {
    setWorkbenchAccountListerForTest(() => [usa, l3])
    expect(noteLimitAnswer(sentence, { now: t0211 })).toBe('usalackor')
    const st = workbenchAccountStatuses(t0211 + 60_000)
    expect(st.find((a) => a.agent === 'usalackor')?.status).toBe('limited')
    expect(st.find((a) => a.agent === 'lackor3')?.status).toBe('online')
    expect(workbenchAccounts(t0211 + 60_000)).toEqual(['lackor3'])
    // A lejarat utan (03:10) a jel magatol megszunik.
    expect(workbenchAccountStatuses(1790644200000 + 1).find((a) => a.agent === 'usalackor')?.status).not.toBe('limited')
  })

  it('nincs egyertelmu fiok -> NEM jelol senkit (a tipp egy mukodo fiokot festene pirosra)', () => {
    setWorkbenchAccountListerForTest(() => [usa, { ...l3, fiveHourResetsAt: 1790644200000 }])
    expect(noteLimitAnswer(sentence, { now: t0211 })).toBeNull()
    setWorkbenchAccountListerForTest(() => [l3])
    expect(noteLimitAnswer(sentence, { now: t0211 })).toBeNull()
  })

  it('ismert fioknal (helyi munkamenet) a jel akkor is all, ha az ido nem illik; a kesobbi friss meres feloldja', () => {
    setWorkbenchAccountListerForTest(() => [l3])
    expect(noteLimitAnswer("You've hit your weekly limit · resets Oct 9, 9am", { configDir: '/cfg/lackor3', now: t0211 })).toBe('lackor3')
    expect(workbenchAccountStatuses(t0211 + 1000)[0].status).toBe('limited')
    setWorkbenchAccountListerForTest(() => [{ ...l3, usageAt: t0211 + 5000, sevenDayPct: 8 }])
    expect(workbenchAccountStatuses(t0211 + 6000)[0].status).toBe('online')
  })

  it('a heti mondat datumat is nezi', () => {
    const r = Date.parse('2026-10-02T07:00:00Z') // 09:00 Budapest
    expect(limitResetMatches("You've hit your weekly limit · resets Oct 2, 9am (Europe/Budapest)", r)).toBe(true)
    expect(limitResetMatches("You've hit your weekly limit · resets Oct 3, 9am (Europe/Budapest)", r)).toBe(false)
    expect(limitResetMatches('resets 3:10am (Europe/Budapest)', 1790644200000)).toBe(true)
    expect(limitResetMatches('resets 3:11am (Europe/Budapest)', 1790644200000)).toBe(false)
  })

  it('elavult (30 percnel regebbi) meres nem zold, hanem "nincs meres"', () => {
    setWorkbenchAccountListerForTest(() => [usa])
    expect(workbenchAccountStatuses(t0211)[0].status).toBe('online') // 26 perces: meg friss
    expect(workbenchAccountStatuses(t0211 + 10 * 60_000)[0].status).toBe('unknown')
  })
})

describe('live account usage beats the statusline file (#434)', () => {
  it('shows an account red when the live answer says 100% although the file says 50%', () => {
    const now = Date.now()
    setWorkbenchAccountListerForTest(() => [{ ...acc('usa', 50, 79), usageAt: now - 60_000 }])
    setLiveOverlayForTest('usa', { fiveHourPct: 100, sevenDayPct: 83, fiveHourResetsAt: now + 3600_000, sevenDayResetsAt: null, measuredAt: now })
    const row = workbenchAccountStatuses(now)[0]
    expect(row.status).toBe('limited')
    expect(row.fiveHourPct).toBe(100)
  })
  it('ignores a stale live answer and falls back to the file', () => {
    const now = Date.now()
    setWorkbenchAccountListerForTest(() => [{ ...acc('usa', 50, 79), usageAt: now - 60_000 }])
    setLiveOverlayForTest('usa', { fiveHourPct: 100, sevenDayPct: 83, fiveHourResetsAt: null, sevenDayResetsAt: null, measuredAt: now - 3 * 3600_000 })
    expect(workbenchAccountStatuses(now)[0].status).toBe('online')
  })
})
