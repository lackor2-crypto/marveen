// #402: a Munkapad fiok-sorrendje. CSAK az 5 oras keret szamit, a heti nem.
import { describe, it, expect, afterEach } from 'vitest'
import { workbenchAccounts, workbenchAccountStatuses, isKnownWorkbenchAccount, setWorkbenchAccountListerForTest } from '../workbench-agent/accounts.js'

const now = Date.now()
const acc = (agent: string, five: number | null, seven: number | null, model = 'claude-opus-5-5') =>
  ({ agent, configDir: `/cfg/${agent}`, model, fiveHourPct: five, sevenDayPct: seven, usageAt: now })

afterEach(() => setWorkbenchAccountListerForTest(null))

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
