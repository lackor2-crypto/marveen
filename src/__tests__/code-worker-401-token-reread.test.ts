// #415 -- the Windows worker re-reads the token file on 401 and retries once.
//
// The measured incident (2026-09-27): the dashboard token was replaced under a
// running worker. The worker had read the token once, at start
// (`$script:BridgeToken = Get-BridgeToken`), so every heartbeat and result POST
// bounced with 401 until the lease expired and the running task was put back in
// the queue; at 03:05 the bridge stood still for the same reason.
//
// WHY THE WORKER AND NOT THE REAPER. The alternative was to have the server not
// reap a lease whose heartbeats "failed with 401". But a 401 is decided before
// the server knows who is calling -- an unauthenticated request cannot be
// trusted to say "I am the worker running task X", so honouring it would let
// anybody who can reach the port pin any running task forever. And a worker
// that truly cannot authenticate cannot deliver its result either; keeping its
// task 'running' would only hide that. The file the worker reads is the same
// one the dashboard now keeps correct (dashboard-token-guard), so re-reading it
// removes the cause instead of papering over the symptom.
//
// The behaviour test runs the REAL functions from the script, cut out of it
// verbatim, under PowerShell against a local HTTP server. CI (ubuntu-latest)
// ships `pwsh`; where there is none the test is skipped and says so. Set
// MARVEEN_PS_RUNNER=powershell.exe on a WSL box to run it under Windows
// PowerShell 5.1 -- the version the worker actually runs on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const ROOT = join(__dirname, '..', '..')
const PS1 = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8').replace(/\r\n/g, '\n')

/** The whole `function Name { ... }` block, as it stands in the script. */
function extractFunction(name: string): string {
  const m = new RegExp(`^function ${name} \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(PS1)
  if (!m) throw new Error(`function ${name} not found in marvin-code-worker.ps1`)
  return m[0]
}

describe('worker script: the 401 path is wired where every call goes through', () => {
  const invoke = extractFunction('Invoke-Bridge')

  it('Invoke-Bridge retries only on 401, with a re-read token', () => {
    expect(invoke).toMatch(/Get-BridgeHttpStatus \$first\) -ne 401\) \{ throw \}/)
    expect(invoke).toContain('Get-BridgeToken')
    // exactly two sends: the original and ONE retry
    expect(invoke.match(/Send-BridgeRequest /g)).toHaveLength(2)
  })

  it('the fresh token is adopted only AFTER the retry got through', () => {
    const retry = invoke.indexOf('-Bearer $fresh')
    const adopt = invoke.indexOf('$script:BridgeToken = $fresh')
    expect(retry).toBeGreaterThan(0)
    expect(adopt).toBeGreaterThan(retry)
  })

  it('the heartbeat and the result POST both go through Invoke-Bridge', () => {
    expect(PS1).toMatch(/Invoke-Bridge -Path \('\/api\/code\/tasks\/' \+ \$Task\.id \+ '\/heartbeat'\)/)
    expect(PS1).toMatch(/Invoke-Bridge -Path \('\/api\/code\/tasks\/' \+ \$claim\.task\.id \+ '\/result'\)/)
    // and nothing calls Invoke-RestMethod around it
    const direct = PS1.split('\n').filter((l) => /Invoke-RestMethod/.test(l) && !/^\s*#/.test(l))
    expect(direct.every((l) => /-Headers \$headers/.test(l))).toBe(true)
    expect(extractFunction('Send-BridgeRequest').match(/Invoke-RestMethod/g)).toHaveLength(2)
  })
})

// ---- behaviour, under a real PowerShell -------------------------------------

function pickRunner(): string | null {
  const forced = process.env.MARVEEN_PS_RUNNER?.trim()
  if (forced) return forced
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  return r.status === 0 ? 'pwsh' : null
}
const RUNNER = pickRunner()
const windowsRunner = !!RUNNER && /\.exe$/i.test(RUNNER)
const toRunnerPath = (p: string): string =>
  windowsRunner ? execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim() : p

const GOOD = 'good-' + 'a'.repeat(59)
const OTHER = 'other-' + 'b'.repeat(58)
const DAMAGED = 'test-token-placeholder'

interface Seen { scenario: string; auth: string; body: string }

describe.skipIf(!RUNNER)(`worker Invoke-Bridge under ${RUNNER ?? 'PowerShell (not installed -- skipped)'}`, () => {
  let server: Server
  let base = ''
  let dir = ''
  const seen: Seen[] = []
  // Which bearer each scenario's endpoint accepts. /boom always fails with 500.
  const accepts: Record<string, string> = { s1: GOOD, s2: GOOD, s3: GOOD, s4: GOOD, s5: GOOD }
  let results: Record<string, { ok: boolean; status?: number; answer?: string; tokenAfter: string }> = {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const scenario = (req.url || '').split('/')[1] || ''
        seen.push({ scenario, auth: String(req.headers.authorization || ''), body })
        if (scenario === 'boom') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"boom"}'); return }
        if (req.headers.authorization === `Bearer ${accepts[scenario]}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, echo: scenario }))
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end('{"error":"Unauthorized"}')
        }
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = mkdtempSync(join(tmpdir(), 'worker-401-'))
    const tokenFile = join(dir, 'dashboard-token')

    const fns = ['Get-BridgeToken', 'Send-BridgeRequest', 'Get-BridgeHttpStatus', 'Invoke-Bridge'].map(extractFunction).join('\n\n')
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const script = `
$ErrorActionPreference = 'Stop'
$BaseUrl = ${q(base)}
$TokenPath = ${q(toRunnerPath(tokenFile))}
$Token = ''
function Write-Log { param([string]$Message, [string]$Level = 'INFO') [Console]::Error.WriteLine('LOG[' + $Level + '] ' + $Message) }
${fns}

$all = @{}
function Run-Case {
  param([string]$Name, [string]$Start, [string]$InFile, [string]$Path)
  [System.IO.File]::WriteAllText($TokenPath, $InFile + [Environment]::NewLine)
  $script:BridgeToken = $Start
  $o = @{}
  try {
    $r = Invoke-Bridge -Path $Path -Method 'POST' -Body @{ host = 'TESTHOST'; runSessionId = 'x' }
    $o.ok = $true; $o.answer = [string]$r.echo
  } catch {
    $o.ok = $false; $o.status = Get-BridgeHttpStatus $_
  }
  $o.tokenAfter = $script:BridgeToken
  $all[$Name] = $o
}
# s1: the token was replaced under the worker; the file has the new one.
Run-Case -Name 's1' -Start ${q(OTHER)} -InFile ${q(GOOD)} -Path '/s1/api/code/tasks/t1/heartbeat'
# s2: nothing wrong -- one request, no re-read noise.
Run-Case -Name 's2' -Start ${q(GOOD)} -InFile ${q(GOOD)} -Path '/s2/api/code/tasks/t1/heartbeat'
# s3: the file is caught mid-damage -- the retry fails, the old token is KEPT.
Run-Case -Name 's3' -Start ${q(OTHER)} -InFile ${q(DAMAGED)} -Path '/s3/api/code/tasks/t1/heartbeat'
# s4: the file says what we already have -- nothing new to try, no retry.
Run-Case -Name 's4' -Start ${q(OTHER)} -InFile ${q(OTHER)} -Path '/s4/api/code/tasks/t1/heartbeat'
# s5: a 500 is not an auth problem -- no re-read, no retry.
Run-Case -Name 's5' -Start ${q(OTHER)} -InFile ${q(GOOD)} -Path '/boom/api/code/tasks/t1/heartbeat'
$all | ConvertTo-Json -Depth 4 -Compress
`
    const scriptFile = join(dir, 'case.ps1')
    // BOM: Windows PowerShell 5.1 reads a BOM-less file as ANSI.
    writeFileSync(scriptFile, '﻿' + script, 'utf8')
    const env = { ...process.env }
    delete env.MARVEEN_DASHBOARD_TOKEN
    const out = await new Promise<string>((resolve, reject) => {
      // async spawn: the HTTP server lives on this event loop and must answer
      const p = spawn(RUNNER!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', toRunnerPath(scriptFile)], { env })
      let so = ''
      let se = ''
      p.stdout.on('data', (c) => { so += c })
      p.stderr.on('data', (c) => { se += c })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve(so) : reject(new Error(`${RUNNER} exited ${code}: ${se}`))))
    })
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
    results = JSON.parse(line)
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()))
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const calls = (s: string): Seen[] => seen.filter((x) => x.scenario === s)

  it('401 with a different token in the file: one retry with it, it goes through, it is kept', () => {
    expect(results.s1).toMatchObject({ ok: true, answer: 's1', tokenAfter: GOOD })
    expect(calls('s1').map((c) => c.auth)).toEqual([`Bearer ${OTHER}`, `Bearer ${GOOD}`])
    // the retry carries the same heartbeat body, not an empty one
    expect(calls('s1')[1].body).toBe(calls('s1')[0].body)
    expect(JSON.parse(calls('s1')[1].body)).toMatchObject({ host: 'TESTHOST' })
  })

  it('no 401: a single request', () => {
    expect(results.s2).toMatchObject({ ok: true, tokenAfter: GOOD })
    expect(calls('s2')).toHaveLength(1)
  })

  it('the retry fails too: the error surfaces as 401 and the old token stays', () => {
    expect(results.s3).toMatchObject({ ok: false, status: 401, tokenAfter: OTHER })
    expect(calls('s3').map((c) => c.auth)).toEqual([`Bearer ${OTHER}`, `Bearer ${DAMAGED}`])
  })

  it('the file holds the same token: no pointless retry', () => {
    expect(results.s4).toMatchObject({ ok: false, status: 401, tokenAfter: OTHER })
    expect(calls('s4')).toHaveLength(1)
  })

  it('a non-401 failure is not retried', () => {
    expect(results.s5).toMatchObject({ ok: false, status: 500, tokenAfter: OTHER })
    expect(calls('boom')).toHaveLength(1)
  })
})
