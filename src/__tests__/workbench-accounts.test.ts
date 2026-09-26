// #402: a Munkapad fiok-sorrendje. CSAK az 5 oras keret szamit, a heti nem.
import { describe, it, expect, afterEach } from 'vitest'
import { workbenchAccounts, setWorkbenchAccountListerForTest } from '../workbench-agent/accounts.js'

const now = Date.now()
const acc = (agent: string, five: number | null, seven: number | null, model = 'claude-opus-5-5') =>
  ({ agent, configDir: `/cfg/${agent}`, model, fiveHourPct: five, sevenDayPct: seven, usageAt: now })

afterEach(() => setWorkbenchAccountListerForTest(null))

describe('workbenchAccounts', () => {
  it('a legtobb 5 oras kerettel rendelkezo elol; a heti 100% NEM szur ki', () => {
    setWorkbenchAccountListerForTest(() => [acc('a', 60, 10), acc('b', 5, 100), acc('c', 30, 50)])
    expect(workbenchAccounts(now)).toEqual(['b', 'c', 'a'])
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
