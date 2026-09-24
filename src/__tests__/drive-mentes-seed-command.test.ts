// #358 (fresh install): the seeded nightly drive-mentes command must not
// raise an alarm when there is simply nothing to back up. Before the fix it
// ran `curl -f`, the endpoint answers 400 code=no_pairs on an install with no
// Drive folders, and after two nights the owner got a red "not responding"
// Telegram alarm for a backup they never set up. This runs the REAL seeded
// command against a stub server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'

const cfg = JSON.parse(readFileSync(resolve(__dirname, '../../seed-scheduled-tasks/drive-mentes/task-config.json'), 'utf8'))

let dir: string
let server: Server
let port = 0
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'drive-mentes-'))
  mkdirSync(join(dir, 'store'))
  writeFileSync(join(dir, 'store', '.dashboard-token'), 'tok\n')
  server = createServer((_req, res) => {
    res.writeHead(reply.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

// spawnSync would block the stub server's event loop; run it async instead.
const run = (status: number, body: unknown): Promise<{ code: number | null; stderr: string }> => {
  reply = { status, body }
  const cmd = String(cfg.command).replaceAll('{{INSTALL_DIR}}', dir).replaceAll('{{WEB_PORT}}', String(port))
  return new Promise((done) => {
    const child = spawn('bash', ['-c', cmd])
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => done({ code, stderr }))
  })
}

describe('drive-mentes seed command (#358)', () => {
  it('a started sync is success', async () => {
    expect((await run(200, { ok: true })).code).toBe(0)
  })

  it('no Drive folder yet (fresh install) is success, not an alarm', async () => {
    expect((await run(400, { error: 'there is no folder to sync', code: 'no_pairs' })).code).toBe(0)
  })

  it('a sync already running is success', async () => {
    expect((await run(409, { error: 'The sync is already running.', code: 'already_running' })).code).toBe(0)
  })

  it('an unreachable depot is still a failure, with the server message in stderr', async () => {
    const r = await run(409, { error: 'A raktár nem érhető el', code: 'depot_unreachable' })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('HTTP 409')
    expect(r.stderr).toContain('depot_unreachable')
  })

  it('a server error is a failure', async () => {
    expect((await run(500, { error: 'boom' })).code).toBe(1)
  })

  it('no token is a failure', () => {
    const cmd = String(cfg.command).replaceAll('{{INSTALL_DIR}}', join(dir, 'nope')).replaceAll('{{WEB_PORT}}', String(port))
    expect(spawnSync('bash', ['-c', cmd]).status).toBe(1)
  })
})
