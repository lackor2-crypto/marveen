// Post-compaction validator (phase 3, kanban 55af1bfe). A compaction summary is
// written by a model and nobody checked it, so what it quietly dropped -- a hard
// requirement, an exact number, the next action -- was lost with no signal. This
// hook compares the summary against the structured checkpoint and says what is
// missing.
//
// Behavioural tests run the python hook as a subprocess (deterministic, no LLM),
// against a real record posted through the live dashboard. Static tests lock the
// wiring so the hook cannot silently stop being registered fleet-wide.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'compaction-validator.py')
const HELPER = join(ROOT, 'scripts', 'checkpoint-state.sh')
const AGENT = 'vitest-compaction-probe'

// The hook resolves the agent from cwd (agents/<name>), so a probe cwd names the
// probe agent without needing a real agent dir on disk.
const PROBE_CWD = join(ROOT, 'agents', AGENT)

// A stub dashboard, so the behavioural half runs anywhere -- including CI with no
// Marveen install. An always-skipped test would be theatre: the point of these
// cases is the comparison logic, and that does not need the real dashboard.
//
// The subprocesses MUST be spawned asynchronously: the stub listens on this same
// event loop, so an execFileSync would block it and the child would wait forever
// for a response that cannot be served until the child exits.
const run = promisify(execFile)
type Record_ = Record<string, unknown>
let server: Server
let stubPort = 0
let stored: Record_ | null = null

// Never write store/.dashboard-token here: that file is what marks a checkout as
// a LIVE install, and creating it makes the whole suite refuse to run in this
// worktree from then on. Both the hook and the helper take the token from the
// environment first, exactly so a test does not have to touch the checkout.
const STUB_TOKEN = 'vitest-stub-token'

beforeAll(async () => {
  server = createServer((req, res) => {
    const isProbe = (req.url ?? '').includes(AGENT)
    if (!isProbe) { res.writeHead(404).end('{}'); return }
    if (req.method === 'DELETE') { stored = null; res.writeHead(200).end('{"ok":true}'); return }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try { stored = JSON.parse(body) as Record_ } catch { stored = null }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, record: { agent: AGENT, ts: Date.now(), consumed: false, ...(stored ?? {}) } }))
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(stored ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  server.unref() // an open handle must never be what keeps vitest alive
  stubPort = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function stubEnv(): NodeJS.ProcessEnv {
  return { ...process.env, WEB_PORT: String(stubPort), MARVEEN_DASHBOARD_TOKEN: STUB_TOKEN }
}

async function runHook(summary: string, trigger = 'auto'): Promise<string> {
  const child = execFile('python3', [HOOK], { env: stubEnv() })
  child.stdin?.end(JSON.stringify({
    hook_event_name: 'PostCompact',
    trigger,
    cwd: PROBE_CWD,
    compact_summary: summary,
  }))
  let out = ''
  child.stdout?.on('data', (c: Buffer | string) => { out += c })
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
  return out
}

async function checkpoint(json: string): Promise<string> {
  const { stdout } = await run('bash', [HELPER, AGENT, json], { env: stubEnv() })
  return stdout
}

describe('compaction-validator hook (behavioural)', () => {
  it('reports a clean bill when the summary carried everything over', async () => {
    await checkpoint(JSON.stringify({
      constraints: ['ne nyulj a semahoz'],
      exactValues: ['kuszob=150000'],
      nextAction: 'futtasd a suite-ot',
    }))
    const out = await runHook('Ne nyulj a semahoz. A kuszob 150000. Kovetkezo: futtasd a suite-ot.')
    expect(out).toContain('minden fontos eleme megvan')
  })

  it('names the dropped constraint and next action', async () => {
    await checkpoint(JSON.stringify({
      constraints: ['ne nyulj a semahoz'],
      nextAction: 'futtasd a suite-ot',
    }))
    const out = await runHook('Az agens dolgozott valamin es folytatja.')
    expect(out).toContain('KIMARADT')
    expect(out).toContain('ne nyulj a semahoz')
    expect(out).toContain('futtasd a suite-ot')
  })

  // The knowledge base singles this out: "timeout = 37 seconds" becoming
  // "roughly 40 seconds" is a defect, not a paraphrase. Numbers must match
  // exactly, so no leniency ratio applies to digits.
  it('catches numerical drift even when the wording survives', async () => {
    await checkpoint(JSON.stringify({ exactValues: ['timeout=37 mp'], nextAction: 'ok' }))
    const out = await runHook('A timeout kb 40 mp. Kovetkezo: ok')
    expect(out).toContain('KIMARADT')
    expect(out).toContain('timeout=37 mp')
  })

  it('accepts a digit-separated number as the same value', async () => {
    await checkpoint(JSON.stringify({ exactValues: ['150000'], nextAction: 'ok' }))
    const out = await runHook('A kuszob 150 000 lett. Kovetkezo: ok')
    expect(out).toContain('minden fontos eleme megvan')
  })

  it('states plainly that there was no checkpoint (idle session is not an error)', async () => {
    stored = null
    const out = await runHook('Rovid beszelgetes volt.')
    expect(out).toContain('nem volt strukturalt checkpoint')
    expect(out).not.toContain('KIMARADT')
  })
})

// The helper is the only sanctioned way to write a checkpoint, so its guards
// matter: a malformed body would store an EMPTY record that then silently
// replays nothing -- the exact failure it exists to prevent.
describe('checkpoint-state.sh guards', () => {
  it('confirms the field count the server kept', async () => {
    const out = await checkpoint(JSON.stringify({ nextAction: 'x', constraints: ['y'] }))
    expect(out).toContain('OK')
    expect(out).toMatch(/2 field\(s\)/)
  })

  it('refuses invalid JSON without calling the API', async () => {
    await expect(checkpoint('not json')).rejects.toThrow()
  })

  it('refuses a payload whose every field is empty', async () => {
    await expect(checkpoint(JSON.stringify({ nextAction: '   ' }))).rejects.toThrow()
  })
})

describe('compaction-validator wiring', () => {
  it('is registered in the shared template for both compaction triggers', () => {
    const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8'))
    const entries = tpl.hooks?.PostCompact ?? []
    const cmds = entries.flatMap((e: { hooks?: Array<{ command?: string }> }) => (e.hooks ?? []).map((h) => h.command ?? ''))
    expect(cmds.some((c: string) => c.includes('compaction-validator.py'))).toBe(true)
    // Claude Code matches PostCompact on the trigger, and a hand-typed /compact
    // reports "manual" -- the same gap that left the PreCompact checkpoint out.
    expect(entries.map((e: { matcher?: string }) => e.matcher)).toContain('auto|manual')
  })

  it('uses the fail-open wrapper so a missing script cannot break a compaction', () => {
    const raw = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
    const tpl = JSON.parse(raw)
    const cmd = tpl.hooks.PostCompact[0].hooks[0].command as string
    expect(cmd.startsWith('bash -c ')).toBe(true)
    expect(cmd).toContain('exit 0')
  })

  it('never hardcodes an install-specific path', () => {
    const raw = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
    const cmd = JSON.parse(raw).hooks.PostCompact[0].hooks[0].command as string
    expect(cmd).toContain('{{PROJECT_ROOT}}')
    expect(cmd).not.toMatch(/\/home\/|\/Users\//)
  })

  it('exits 0 on garbage input (fail-open)', () => {
    const out = execFileSync('python3', [HOOK], { input: 'not json', encoding: 'utf-8' })
    expect(out).toBe('')
  })
})
