/**
 * #396 Phase 2 -- retention: GFS per destination, and the hard rules that no
 * policy can override (newest verified, young pre-restore, failed listing).
 */
import { describe, it, expect } from 'vitest'
import { planPrune, POLICIES, timeFromName, type BackupEntry } from '../backup/retention.js'
import { backupFileName } from '../backup/create.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime()

function daily(days: number, perDay = 1): BackupEntry[] {
  const out: BackupEntry[] = []
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const t = new Date(NOW - d * DAY - k * 6 * 60 * 60 * 1000)
      const name = backupFileName(t, 'host')
      out.push({ name, time: timeFromName(name) })
    }
  }
  return out
}

describe('timeFromName', () => {
  it('reads the local wall clock from the name', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    expect(timeFromName(backupFileName(d, 'h'))).toBe(d.getTime())
    expect(timeFromName('whatever.mbk')).toBeNaN()
  })
})

describe('planPrune', () => {
  it('local keeps the newest 3', () => {
    const list = daily(10)
    const { keep, drop } = planPrune(list, POLICIES.local, NOW)
    expect(keep.map((e) => e.name)).toEqual(list.slice(0, 3).map((e) => e.name))
    expect(drop).toHaveLength(7)
  })

  it('depot over 120 days, 4 a day: 7 daily + 4 weekly + 6 monthly, overlapping', () => {
    const list = daily(120, 4)
    const { keep } = planPrune(list, POLICIES.depot, NOW)
    const days = new Set(keep.map((e) => new Date(e.time).toDateString()))
    // Every kept backup is the newest of its day.
    for (const e of keep) {
      const sameDay = list.filter((x) => new Date(x.time).toDateString() === new Date(e.time).toDateString())
      expect(Math.max(...sameDay.map((x) => x.time))).toBe(e.time)
    }
    expect(keep.length).toBe(days.size)
    // The 7 newest days are all there.
    for (let d = 0; d < 7; d++) expect(days.has(new Date(NOW - d * DAY).toDateString())).toBe(true)
    // Between 7 (all overlap) and 17 (none overlap) distinct days; months reach back ~5 months.
    expect(keep.length).toBeGreaterThanOrEqual(12)
    expect(keep.length).toBeLessThanOrEqual(17)
    const oldest = Math.min(...keep.map((e) => e.time))
    expect(NOW - oldest).toBeGreaterThan(100 * DAY)
  })

  it('never drops the newest verified backup', () => {
    const list = daily(30)
    list[20].verified = true
    const { keep } = planPrune(list, POLICIES.local, NOW)
    expect(keep.map((e) => e.name)).toContain(list[20].name)
  })

  it('never drops a pre-restore backup younger than 30 days, but an older one goes', () => {
    const list = daily(40)
    list[25].kind = 'pre-restore'
    list[35].kind = 'pre-restore'
    const { keep } = planPrune(list, POLICIES.local, NOW)
    const names = keep.map((e) => e.name)
    expect(names).toContain(list[25].name)
    expect(names).not.toContain(list[35].name)
  })

  it('an empty listing drops nothing, an unparsable name is kept', () => {
    expect(planPrune([], POLICIES.cloud, NOW)).toEqual({ keep: [], drop: [] })
    const odd = { name: 'foreign.mbk', time: NaN }
    expect(planPrune([...daily(10), odd], POLICIES.local, NOW).keep).toContainEqual(odd)
  })
})
