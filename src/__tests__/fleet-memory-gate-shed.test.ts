// The memory gate only ever gated NEW agent starts. On 2026-08-12 that was not
// enough: 14 agents were already running on a 7.8 GB WSL VM when the kernel hit
// a page-allocation failure (18:03), the VM slowed to one log line per 6.5
// minutes and went down at 18:10. Boss reported it as "the dashboard froze".
// The gate reported band=ok throughout, correctly by its own contract -- nothing
// new was trying to start.
//
// `--shed` closes that hole: in the hard band it parks ONE already-running agent
// per sweep. The rules it must never break are what this file pins down, because
// getting them wrong means killing an agent mid-turn (lost work) or stopping the
// owner's primary bot.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const GATE = join(__dirname, '..', '..', 'scripts', 'fleet-memory-gate.sh')

type Row = { name: string; running: boolean; state: string; isMain?: boolean }

// A stub of GET /api/agents/activity -- the dashboard endpoint the gate asks
// "who is idle?". Serving the real classifier's output shape keeps the shell out
// of the business of deciding whether a pane is busy.
let served: Row[] = []
let server: Server
let port = 0
let store = ''

beforeAll(async () => {
  store = mkdtempSync(join(tmpdir(), 'memgate-shed-'))
  writeFileSync(join(store, '.dashboard-token'), 'test-token\n')
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/agents/activity')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(served))
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  expect(port).toBeGreaterThan(0)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

// Must be async: the stub dashboard is served by THIS process, so a synchronous
// child (execFileSync) would block the event loop and the gate's curl would time
// out against a server that can never answer. The same event-loop rule the
// dashboard itself keeps tripping over.
async function runShed(rows: Row[], env: Record<string, string> = {}, overridePort?: number): Promise<string> {
  served = rows
  const { stdout } = await execFileAsync('/bin/bash', [GATE, '--shed', '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WEB_PORT: String(overridePort ?? port),
      MARVEEN_STORE: store,
      MARVEEN_CORE_AGENTS: 'primary',
      // Force the hard band regardless of the machine running the test.
      MARVEEN_MEM_HARD_PCT: '0',
      MARVEEN_MEM_GATE_OBSERVE: '0',
      ...env,
    },
  })
  return stdout
}

const IDLE_SUB: Row = { name: 'sub-idle', running: true, state: 'idle', isMain: false }

describe('fleet-memory-gate --shed', () => {
  it('parks an idle non-core agent when the VM is in the hard band', async () => {
    expect(await runShed([IDLE_SUB])).toContain('would-shed sub-idle')
  })

  it('never parks an agent that is working -- that would throw away a live turn', async () => {
    const out = await runShed([{ name: 'sub-busy', running: true, state: 'working', isMain: false }])
    expect(out).toContain('no-idle-candidate')
    expect(out).not.toContain('sub-busy')
  })

  it('never parks the main agent, however idle it looks', async () => {
    expect(await runShed([{ name: 'primary', running: true, state: 'idle', isMain: true }]))
      .toContain('no-idle-candidate')
  })

  it('never parks a core agent named in MARVEEN_CORE_AGENTS', async () => {
    expect(await runShed([{ name: 'primary', running: true, state: 'idle', isMain: false }]))
      .toContain('no-idle-candidate')
  })

  it('ignores agents that are already stopped', async () => {
    expect(await runShed([{ name: 'sub-down', running: false, state: 'stopped', isMain: false }]))
      .toContain('no-idle-candidate')
  })

  it('picks an idle agent even when its footprint cannot be measured', async () => {
    // No tmux session exists for these names under test, so every candidate
    // measures 0 KB. Ranking by size must not make them all unsheddable --
    // that would switch shedding off silently on a host without tmux.
    const out = await runShed([IDLE_SUB, { name: 'sub-idle-2', running: true, state: 'idle', isMain: false }])
    expect(out).toContain('would-shed')
  })

  it('does nothing outside the hard band, even with an idle agent available', async () => {
    // 100% means "only shed when literally no memory is available", i.e. never here.
    const out = await runShed([IDLE_SUB], { MARVEEN_MEM_HARD_PCT: '100' })
    expect(out).toMatch(/no-shed \(band=(ok|warn)/)
    expect(out).not.toContain('would-shed')
  })

  it('sheds nothing when the dashboard cannot be reached (fail-safe)', async () => {
    expect(await runShed([IDLE_SUB], {}, 1)).toContain('no-idle-candidate')
  })

  it('stops through the dashboard route, so the reconcile loop cannot undo it', () => {
    const src = readFileSync(GATE, 'utf8')
    // /stop also clears the desired run-state; a bare tmux kill would be
    // restarted within 60s and turn shedding into an oscillation.
    expect(src).toMatch(/api\/agents\/\$\{best\}\/stop/)
  })
})
