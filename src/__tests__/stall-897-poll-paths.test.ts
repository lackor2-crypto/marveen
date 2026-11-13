// #897: two things the server did on a timer or on every worker poll, on its only thread.
//  - the channel monitor asked tmux, ps and pgrep about every agent once a minute, each a
//    synchronous child process (measured 738-837 ms per agent on the loaded machine),
//  - every code-bridge worker poll read the worker script from disk to learn the expected
//    version (measured 3.6 s when the disk was busy).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(__dirname, '..', '..')
const reads = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return { ...real, readFileSync: (...a: Parameters<typeof real.readFileSync>) => { if (String(a[0]).endsWith('marvin-code-worker.ps1')) reads.n++; return real.readFileSync(...a) } }
})

describe('the expected worker version is not read from disk on every poll (#897)', () => {
  beforeEach(() => { reads.n = 0 })
  it('one read serves a minute of polls, then the file is looked at again', async () => {
    const { expectedWorkerVersion, _resetExpectedWorkerVersionForTest } = await import('../web/code-worker-version.js')
    _resetExpectedWorkerVersionForTest()
    const t0 = 1_800_000_000_000
    const first = expectedWorkerVersion(t0)
    expect(first).toMatch(/\S/)
    for (let i = 1; i <= 50; i++) expect(expectedWorkerVersion(t0 + i * 1000)).toBe(first)
    expect(reads.n).toBe(1)
    expectedWorkerVersion(t0 + 61_000)
    expect(reads.n).toBe(2)
    // a clock that went backwards does not pin an old answer
    expectedWorkerVersion(t0 - 5_000)
    expect(reads.n).toBe(3)
  })
})

describe('the per-agent liveness poll does not hold the thread (#897)', () => {
  it('the async lookup answers null for a session that does not exist, without throwing', async () => {
    const { getClaudePidForSessionAsync } = await import('../channel-coordinator/liveness.js')
    let ticked = false
    const p = getClaudePidForSessionAsync('no-such-session-897-' + process.pid)
    setImmediate(() => { ticked = true })
    expect(await p).toBeNull()
    // the event loop ran while the child process was out
    expect(ticked).toBe(true)
  })
  it('the monitor loop over all agents uses it', () => {
    const src = readFileSync(join(REPO, 'src/web/channel-monitor.ts'), 'utf8')
    expect(src).toMatch(/for \(const t of targets\) \{\s*const claudePid = await getClaudePidForSessionAsync\(t\.session\)/)
    expect(src).toContain('const liveness = await probeChannelPluginLivenessAsync(claudePid, t.provider, t.agentName)')
    const live = readFileSync(join(REPO, 'src/channel-coordinator/liveness.ts'), 'utf8')
    const body = live.slice(live.indexOf('export async function getClaudePidForSessionAsync'), live.indexOf('Pure decision: does the parsed'))
    expect(body).not.toMatch(/execFileSync|execSync|spawnSync/)
    const probe = live.slice(live.indexOf('export async function probeChannelPluginLivenessAsync'), live.indexOf('function verdictFromPs'))
    expect(probe).not.toMatch(/execFileSync|execSync|spawnSync/)
  })
  it('the async probe gives a verdict from a real process snapshot', async () => {
    const { probeChannelPluginLivenessAsync, probeChannelPluginLiveness } = await import('../channel-coordinator/liveness.js')
    // this test process is not a claude with a channel plugin under it: both forms must agree
    expect(await probeChannelPluginLivenessAsync(process.pid, 'telegram', 'no-such-agent-897')).toBe(probeChannelPluginLiveness(process.pid, 'telegram', 'no-such-agent-897'))
  })
  it('the worker boot does not wait for `claude --version`', () => {
    const src = readFileSync(join(REPO, 'src/web/agent-worker.ts'), 'utf8')
    const body = src.slice(src.indexOf('function logWorkerClaudeVersion'), src.indexOf('function shArg'))
    expect(body).toMatch(/execFile\(claudeBin, \['--version'\]/)
    expect(body).not.toMatch(/execFileSync|execSync|spawnSync/)
  })
})
