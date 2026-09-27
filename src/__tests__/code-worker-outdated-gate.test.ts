// Elavult vegrehajto nem kap uj munkat, amig nem frissitette magat (kanban #425).
import { describe, it, expect, beforeAll } from 'vitest'
import { initDatabase } from '../db.js'
import { recordCodeWorkerSeen } from '../web/code-bridge-store.js'
import { outdatedWorkerHeld } from '../web/routes/code.js'
import { expectedWorkerVersion } from '../web/code-worker-version.js'

// One database for the file: the store creates its tables once per process.
beforeAll(() => { initDatabase(':memory:') })

describe('outdated worker gate (#425)', () => {
  it('a regi verziot jelento worker 10 percig nem kap uj feladatot, utana igen', () => {
    const expectV = expectedWorkerVersion()
    expect(expectV).not.toBeNull()
    recordCodeWorkerSeen('HOST-OLD', 'discovery', 2, Date.now(), '2000-01-01.1')
    const t0 = Date.now()
    expect(outdatedWorkerHeld('HOST-OLD', t0)).toBe(true)
    expect(outdatedWorkerHeld('HOST-OLD', t0 + 9 * 60_000)).toBe(true)
    expect(outdatedWorkerHeld('HOST-OLD', t0 + 11 * 60_000)).toBe(false)
  })

  it('friss verzio, vagy verziot nem jelento worker: nincs visszatartas', () => {
    recordCodeWorkerSeen('HOST-NEW', 'discovery', 2, Date.now(), expectedWorkerVersion())
    expect(outdatedWorkerHeld('HOST-NEW')).toBe(false)
    recordCodeWorkerSeen('HOST-NOVER', 'claim')
    expect(outdatedWorkerHeld('HOST-NOVER')).toBe(false)
  })

  it('#425: a CLAIM-en jelentett friss verzio azonnal feloldja a visszatartast (nem kell felderites)', () => {
    // A worker regi verziot jelentett, tehat vissza van tartva.
    recordCodeWorkerSeen('HOST-UPD', 'discovery', 2, Date.now(), '2000-01-01.1')
    expect(outdatedWorkerHeld('HOST-UPD')).toBe(true)
    // Frissitette magat, es a KOVETKEZO claim mar a friss verziot viszi --
    // felderitesi kor nelkul. Innentol nincs visszatartas: nem kell megvarni a
    // ~7,5 perces beszelgetes-atnezest (kanban #425).
    recordCodeWorkerSeen('HOST-UPD', 'claim', undefined, Date.now(), expectedWorkerVersion())
    expect(outdatedWorkerHeld('HOST-UPD')).toBe(false)
  })

  it('#425: a verziot NEM jelento (regi) claim nem irja felul a tarolt verziot', () => {
    recordCodeWorkerSeen('HOST-KEEP', 'discovery', 2, Date.now(), expectedWorkerVersion())
    // Egy verzio nelkuli claim (regi worker) nem nullazza a mezot.
    recordCodeWorkerSeen('HOST-KEEP', 'claim')
    expect(outdatedWorkerHeld('HOST-KEEP')).toBe(false)
  })
})
