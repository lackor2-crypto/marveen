// Kanban #451: the SessionStart hook must ask the running dashboard who can work
// now, and must say "start the work yourself" when the designated agent cannot.
// The hook is a Python script, so it runs for real here against a fake dashboard.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

const HOOK = path.resolve(__dirname, '../../scripts/hooks/broker-role.py')

let root = ''
let server: http.Server
let port = 0
let reply: { status: number; body: unknown } = { status: 200, body: {} }

function run(agent: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      [path.join(root, 'scripts', 'hooks', 'broker-role.py')],
      { env: { ...process.env, WEB_PORT: String(port), MAIN_AGENT_ID: 'mainbot' }, timeout: 15000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin!.end(JSON.stringify({ cwd: path.join(root, 'agents', agent) }))
  })
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-hook-'))
  fs.mkdirSync(path.join(root, 'scripts', 'hooks'), { recursive: true })
  fs.copyFileSync(HOOK, path.join(root, 'scripts', 'hooks', 'broker-role.py'))
  fs.mkdirSync(path.join(root, 'store'))
  fs.mkdirSync(path.join(root, 'agents', 'worker'), { recursive: true })
  fs.writeFileSync(path.join(root, 'store', '.dashboard-token'), 'test-token')
  fs.writeFileSync(path.join(root, 'store', 'context-broker.json'), JSON.stringify({ designated: 'boss-bot' }))
  server = http.createServer((req, res) => {
    res.writeHead(reply.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.body))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('broker-role.py SessionStart hook (#451)', () => {
  it('tells everyone to start at once when the designated agent is unavailable', async () => {
    reply = { status: 200, body: { designated: 'boss-bot', effective: 'stand-in', reason: 'fallback-quota' } }
    const out = await run('worker')
    expect(out).toContain('nem elerheto')
    expect(out).toContain('kimerult a kerete')
    expect(out).toContain('kezdj neki AZONNAL')
    expect(out).not.toContain('a kontextusgenerator')
  })

  it('names a stopped designee as not running', async () => {
    reply = { status: 200, body: { designated: 'boss-bot', effective: 'stand-in', reason: 'fallback-stopped' } }
    expect(await run('worker')).toContain('nem fut')
  })

  it('treats "nobody can broker" (effective null) as unavailable too', async () => {
    reply = { status: 200, body: { designated: 'boss-bot', effective: null, reason: 'unavailable' } }
    expect(await run('worker')).toContain('kezdj neki AZONNAL')
  })

  it('keeps the normal worker notice when the designee can work', async () => {
    reply = { status: 200, body: { designated: 'boss-bot', effective: 'boss-bot', reason: 'designated' } }
    const out = await run('worker')
    expect(out).not.toContain('kezdj neki AZONNAL')
    expect(out).toContain('boss-bot')
  })

  it('fails open: a dashboard error falls back to the plain designation', async () => {
    reply = { status: 500, body: { error: 'boom' } }
    const out = await run('worker')
    expect(out).not.toContain('kezdj neki AZONNAL')
    expect(out).toContain('boss-bot')
  })

  it('always carries the hand-over rule: check availability first, wait at most 30 minutes', async () => {
    reply = { status: 200, body: { designated: 'boss-bot', effective: 'boss-bot', reason: 'designated' } }
    const out = await run('worker')
    expect(out).toContain('Atadas elott')
    expect(out).toContain('30 percnel tovabb ne varj')
  })

  describe('several holders per role (#541)', () => {
    const cfgPath = () => path.join(root, 'store', 'context-broker.json')
    const ok = { designated: 'boss-bot', effective: 'boss-bot', reason: 'designated' }
    afterAll(() => {
      fs.writeFileSync(cfgPath(), JSON.stringify({ designated: 'boss-bot' }))
    })

    it('gives an agent its own role even when another agent holds the same one', async () => {
      fs.writeFileSync(cfgPath(), JSON.stringify({
        designated: 'boss-bot',
        roles: { implementer: ['other', 'worker'] },
      }))
      reply = { status: 200, body: ok }
      const out = await run('worker')
      expect(out).toContain('A kartyadon ez a szereped: megvalosito.')
    })

    it('reads the old one-name-per-role file shape', async () => {
      fs.writeFileSync(cfgPath(), JSON.stringify({
        designated: 'boss-bot',
        roles: { checker: 'worker' },
      }))
      reply = { status: 200, body: ok }
      expect(await run('worker')).toContain('A kartyadon ez a szereped: ellenorzo.')
    })

    it('says nothing about a role this agent does not hold', async () => {
      fs.writeFileSync(cfgPath(), JSON.stringify({
        designated: 'boss-bot',
        roles: { implementer: ['other', 'third'] },
      }))
      reply = { status: 200, body: ok }
      expect(await run('worker')).not.toContain('A kartyadon ez a szereped')
    })
  })
})
