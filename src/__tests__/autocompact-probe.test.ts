import { describe, it, expect, vi } from 'vitest'
import { createAutocompactProbe, type HelpRun } from '../web/autocompact-probe.js'

// #885 follow-up: behaviour (not source text) of the `claude --help` probe. Regressions pinned:
//  - a restart must not spawn `claude --help` synchronously when the answer is already known on disk,
//  - a timed-out background probe must NOT be cached as "no --autocompact" (silently drops the context ceiling),
//  - an agent start that happens while the background probe is still running must reuse its answer, not block.
const OK_WITH = (stdout = 'Options:\n  --autocompact <n>  window'): HelpRun => ({ ok: true, timedOut: false, stdout })

function mk(over: Partial<Parameters<typeof createAutocompactProbe>[0]> = {}) {
  const disk = new Map<string, string>()
  const runHelpSync = vi.fn((): HelpRun => OK_WITH())
  const runHelpAsync = vi.fn(async (): Promise<HelpRun> => OK_WITH())
  const probe = createAutocompactProbe({
    binIdentity: () => ({ mtimeMs: 1, size: 2 }),
    cacheFile: '/x/probe.json',
    runHelpAsync,
    runHelpSync,
    readCache: (f) => disk.get(f) ?? null,
    writeCache: (f, d) => { disk.set(f, d) },
    ...over,
  })
  return { probe, disk, runHelpSync, runHelpAsync }
}

describe('autocompact probe stays off the event loop', () => {
  it('a known on-disk answer for the same binary means no spawn at all, sync or async', () => {
    const { probe, disk, runHelpSync, runHelpAsync } = mk()
    disk.set('/x/probe.json', JSON.stringify({ mtimeMs: 1, size: 2, supported: true }))
    expect(probe.get()).toBe(true)
    void probe.warm()
    expect(runHelpSync).not.toHaveBeenCalled()
    expect(runHelpAsync).not.toHaveBeenCalled()
  })

  it('a changed binary invalidates the disk answer', async () => {
    const { probe, disk, runHelpAsync } = mk({ binIdentity: () => ({ mtimeMs: 9, size: 2 }) })
    disk.set('/x/probe.json', JSON.stringify({ mtimeMs: 1, size: 2, supported: false }))
    await probe.warm()
    expect(runHelpAsync).toHaveBeenCalledTimes(1)
    expect(probe.peek()).toBe(true)
  })

  it('a background answer is persisted and a later get() does not block', async () => {
    const { probe, disk, runHelpSync } = mk()
    await probe.warm()
    expect(probe.get()).toBe(true)
    expect(runHelpSync).not.toHaveBeenCalled()
    expect(JSON.parse(disk.get('/x/probe.json')!)).toEqual({ mtimeMs: 1, size: 2, supported: true })
  })

  it('a timed-out background probe is not cached as "unsupported"', async () => {
    const { probe, disk } = mk({ runHelpAsync: async () => ({ ok: false, timedOut: true, stdout: '' }) })
    await probe.warm()
    expect(probe.peek()).toBeNull()
    expect(disk.size).toBe(0)
  })

  it('a help text without the flag is cached as unsupported', async () => {
    const { probe, disk } = mk({ runHelpAsync: async () => OK_WITH('Options:\n  --model') })
    await probe.warm()
    expect(probe.get()).toBe(false)
    expect(JSON.parse(disk.get('/x/probe.json')!).supported).toBe(false)
  })

  it('the sync run is only the last resort, and a sync timeout is not written to disk', () => {
    const { probe, disk, runHelpSync } = mk({ runHelpSync: vi.fn((): HelpRun => ({ ok: false, timedOut: true, stdout: '' })) })
    expect(probe.get()).toBe(false)
    expect(probe.get()).toBe(false)
    expect(disk.size).toBe(0)
    void runHelpSync
  })

  it('repeated warm() calls share one background run', async () => {
    const { probe, runHelpAsync } = mk()
    await Promise.all([probe.warm(), probe.warm(), probe.warm()])
    expect(runHelpAsync).toHaveBeenCalledTimes(1)
  })

  it('a corrupt or unwritable cache never breaks the probe', async () => {
    const { probe } = mk({ readCache: () => '{not json', writeCache: () => { throw new Error('EROFS') } })
    await probe.warm()
    expect(probe.get()).toBe(true)
  })
})
