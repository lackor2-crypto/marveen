// realPidLockDeps.argvOf: how /proc/<pid>/cmdline plus kill(pid, 0) are turned
// into string (the command line) / null (the process is gone) / undefined
// (cannot tell). Upstream measured this against /bin/ps; here it reads /proc, because
// a synchronous ps child is forbidden on this fork (#897 gate). node:fs is wrapped per
// case and process.kill is stubbed.
//
// The fail-closed cases are the point (A, B, D): a LIVE holder whose cmdline is
// empty or unreadable must never read as "gone", because "gone" is what lets a second
// coordinator unlink the pid file and take the lock -> two pollers on one bot
// token -> 409 churn. Only ESRCH from kill(pid, 0) demotes it to null.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { realPidLockDeps } from '../channel-coordinator.js'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, readFileSync: vi.fn(real.readFileSync), existsSync: vi.fn(real.existsSync) }
})

const PID = 424242
const CMDLINE = `/proc/${PID}/cmdline`
const read = vi.mocked(fs.readFileSync)
const real = await vi.importActual<typeof import('node:fs')>('node:fs')

const cmdlineIs = (outcome: string | Error) => {
  read.mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (p === CMDLINE) {
      if (typeof outcome === 'string') return outcome
      throw outcome
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof fs.readFileSync)
}
const errno = (code: string) => Object.assign(new Error(code), { code })
const killSucceeds = () => vi.spyOn(process, 'kill').mockImplementation(() => true)
const killThrows = (code: string) => vi.spyOn(process, 'kill').mockImplementation(() => { throw errno(code) })

beforeEach(() => { read.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('realPidLockDeps.argvOf', () => {
  it('A: empty cmdline, kill(pid, 0) succeeds -> undefined, never null (fail closed)', () => {
    killSucceeds()
    cmdlineIs('')
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
  })

  it('B: cmdline vanished (ENOENT), kill(pid, 0) succeeds -> undefined, never null (fail closed)', () => {
    killSucceeds()
    cmdlineIs(errno('ENOENT'))
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
  })

  it('C: cmdline vanished (ENOENT), kill throws ESRCH -> null (gone); control for B', () => {
    killThrows('ESRCH')
    cmdlineIs(errno('ENOENT'))
    expect(realPidLockDeps.argvOf(PID)).toBeNull()
  })

  it('D: empty cmdline, kill throws EPERM -> undefined, never null (alive but not ours)', () => {
    killThrows('EPERM')
    cmdlineIs('')
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
  })

  it('E: a readable cmdline is returned with the NUL separators turned into spaces', () => {
    killSucceeds()
    cmdlineIs('node\0/x/dist/channel-coordinator.js\0')
    expect(realPidLockDeps.argvOf(PID)).toBe('node /x/dist/channel-coordinator.js')
  })

  it('E2: an unreadable cmdline (EACCES) is unknown, not gone', () => {
    killThrows('ESRCH')
    cmdlineIs(errno('EACCES'))
    expect(realPidLockDeps.argvOf(PID)).toBeUndefined()
  })

  it('F: the real thing reads this very process', () => {
    read.mockImplementation(real.readFileSync as typeof fs.readFileSync)
    expect(realPidLockDeps.argvOf(process.pid)).toContain('node')
  })
})
