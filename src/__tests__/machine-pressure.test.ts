// #897: the dashboard knows when the machine is busy, and says so in numbers.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePressure, busyReasons, measurePressure, machineBusy, currentPressure, noteStallForPressure, describePressure,
  _setPressureForTest, _resetPressureWatch, type PressureSnapshot,
} from '../machine-pressure.js'

const limits = { cpu: 25, io: 15, memory: 5, loadPerCore: 1.5 }
const snap = (o: Partial<PressureSnapshot> = {}): PressureSnapshot => ({ at: Date.now(), cpu: 0, io: 0, memory: 0, load1: 0.5, cores: 8, ...o })

describe('#897 machine pressure', () => {
  afterEach(() => _resetPressureWatch())

  it('reads "some avg10" from a kernel pressure file', () => {
    expect(parsePressure('some avg10=12.34 avg60=1.00 avg300=0.50 total=123\nfull avg10=3.00 avg60=0 avg300=0 total=1\n')).toBe(12.34)
    expect(parsePressure('garbage')).toBeNull()
  })

  it('measures from a directory; a missing file is "not measured" (null), never a made-up zero', async () => {
    const d = mkdtempSync(join(tmpdir(), 'psi-'))
    writeFileSync(join(d, 'cpu'), 'some avg10=40.00 avg60=0 avg300=0 total=0\n')
    const s = await measurePressure(d, 5)
    expect(s.cpu).toBe(40)
    expect(s.io).toBeNull()
    expect(s.memory).toBeNull()
    expect(s.cores).toBeGreaterThan(0)
  })

  it('names why the machine is busy; a calm machine has no reason', () => {
    expect(busyReasons(snap(), limits)).toEqual([])
    expect(busyReasons(snap({ cpu: 25 }), limits)).toEqual(['cpu'])
    expect(busyReasons(snap({ io: 30, memory: 6 }), limits)).toEqual(['io', 'memory'])
    // the load average speaks only where the kernel gave no CPU figure
    expect(busyReasons(snap({ cpu: null, load1: 20 }), limits)).toEqual(['load'])
    expect(busyReasons(snap({ cpu: 1, load1: 20 }), limits)).toEqual([])
  })

  it('nothing measured = not busy: "could not look" never blocks work', () => {
    expect(currentPressure()).toBeNull()
    expect(machineBusy().busy).toBe(false)
    expect(busyReasons(null)).toEqual([])
  })

  it('an old measurement says nothing about now', () => {
    const now = 1_000_000
    _setPressureForTest(snap({ at: now - 31_000, cpu: 90 }))
    expect(currentPressure(now)).toBeNull()
    expect(machineBusy(now).busy).toBe(false)
    _setPressureForTest(snap({ at: now - 1000, cpu: 90 }))
    expect(machineBusy(now)).toEqual({ busy: true, reasons: ['cpu'] })
  })

  it('a long stall makes the machine count as busy for a short while, then it passes', () => {
    const now = 2_000_000
    noteStallForPressure(500, now)
    expect(machineBusy(now).busy).toBe(false)
    noteStallForPressure(1500, now)
    expect(machineBusy(now + 1000).reasons).toEqual(['stall'])
    expect(machineBusy(now + 21_000).busy).toBe(false)
  })

  it('describes the figures in both languages, and says so when there are none', () => {
    const s = snap({ cpu: 31.6, io: null, memory: 0, load1: 9.25 })
    expect(describePressure(s, 'hu')).toBe('processzorra várakozás 32%, lemezre nincs adat, memóriára 0%, terhelés 9.3 / 8 mag')
    expect(describePressure(s, 'en')).toContain('waiting for CPU 32%, for disk no data')
    expect(describePressure(null, 'hu')).toContain('nem mértük')
    expect(describePressure(null, 'en')).toContain('not measured')
  })
})
