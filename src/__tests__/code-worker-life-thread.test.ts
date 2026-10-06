import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * TG 2468 (2026-10-06): the worker's sign of life and the task heartbeat were written by the main thread only, which
 * also runs the slow discovery pass. A pass longer than 180 s made the 5-minute restarter take the worker over (123
 * times since 2026-10-02) and every kill burnt one attempt of the running task. A separate runspace now carries both.
 */
const PS1 = readFileSync(join(__dirname, '..', '..', 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8').replace(/\r\n/g, '\n')

describe('worker script: the life thread', () => {
  it('starts only in the instance that holds the mutex, right before the loop', () => {
    const start = PS1.indexOf('Start-LifeThread\ntry {\n  Start-WorkerLoop')
    expect(start).toBeGreaterThan(PS1.indexOf('$mutex.WaitOne(0)'))
  })

  it('writes the sign of life and the running task heartbeat on its own clock', () => {
    expect(PS1).toMatch(/function Start-LifeThread/)
    expect(PS1).toMatch(/\[runspacefactory\]::CreateRunspace\(\)/)
    expect(PS1).toMatch(/WriteAllText\(\$AliveFile/)
    expect(PS1).toMatch(/\/heartbeat'/)
  })

  it('the main thread tells it which task runs and that it is still progressing', () => {
    expect(PS1).toMatch(/\$script:Life\.TaskId = \$Task\.id/)
    expect(PS1).toMatch(/\$script:Life\.TaskId = \$null/)
    expect(PS1).toMatch(/\$script:Life\.MainBeat = /)
  })

  it('stops vouching when the main thread itself made no progress for a long time (a hung worker is still taken over)', () => {
    expect(PS1).toMatch(/\$script:LifeMaxStallSec = \d+/)
    expect(PS1).toMatch(/\$stall -lt \$MaxStall/)
  })
})
