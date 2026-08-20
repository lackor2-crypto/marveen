import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claimScheduleOwnership } from '../web/scheduled-tasks-io.js'

// Ket telepites EGY HOME-on ugyanazt az utemezes-keszletet hasznalna, es minden
// feladat KETSZER futna le. A jelzo nem tilt -- de nevesiti a masik telepitest.
describe('claimScheduleOwnership', () => {
  let dir: string
  let ownerFile: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sched-owner-'))
    ownerFile = join(dir, '.owner')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('elso igenylesnel nincs elozo tulajdonos, es beirja az utat', () => {
    const r = claimScheduleOwnership('/opt/marveen-A', ownerFile)
    expect(r.previousOwner).toBeNull()
    expect(r.claimed).toBe(true)
    expect(readFileSync(ownerFile, 'utf8').trim()).toBe('/opt/marveen-A')
  })

  it('ugyanaz a telepites nem jelent utkozest', () => {
    writeFileSync(ownerFile, '/opt/marveen-A\n')
    expect(claimScheduleOwnership('/opt/marveen-A', ownerFile).previousOwner).toBeNull()
  })

  it('MAS, letezo telepites -> nevesiti (ez a duplan futas)', () => {
    writeFileSync(ownerFile, '/opt/marveen-A\n')
    const r = claimScheduleOwnership('/opt/marveen-B', ownerFile, p => p === '/opt/marveen-A' || existsSync(p))
    expect(r.previousOwner).toBe('/opt/marveen-A')
    // ...es atveszi a jelzot, tehat nem riaszt minden egyes inditasnal ujra
    expect(readFileSync(ownerFile, 'utf8').trim()).toBe('/opt/marveen-B')
  })

  it('ATHELYEZETT telepites nem ad hamis riasztast (a regi ut mar nincs meg)', () => {
    writeFileSync(ownerFile, '/regi/hely/marveen\n')
    const r = claimScheduleOwnership('/uj/hely/marveen', ownerFile, p => p === ownerFile)
    expect(r.previousOwner).toBeNull()
  })

  it('irhatatlan jelzo sem dobhat -- az utemezo indulasat nem dontheti el', () => {
    const r = claimScheduleOwnership('/opt/marveen-A', join(dir, 'nincs-ilyen', 'x', '.owner'), () => {
      throw new Error('lemez hiba')
    })
    expect(r.claimed).toBe(false)
    expect(r.previousOwner).toBeNull()
  })
})
