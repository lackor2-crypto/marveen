import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getDashboardUser, getRecentConfigChanges } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { requiresAuth } from '../web/auth-gate.js'
import { hashPassword, verifyPassword } from '../web/password-hash.js'
import { createSession, resolveSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import {
  _setRecoveryDeps,
  _resetRecoveryState,
  requestCode,
  verifyCode,
  CODE_TTL_MS,
  type MailPort,
} from '../web/password-recovery.js'
import { createDashboardUser } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

// #412 -- forgotten password -> one-time code on the owner's verified channel.

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => {}),
  notifyTelegram: vi.fn(async () => {}),
  notifySecurityEvent: vi.fn(async () => {}),
  ownerChannelReady: vi.fn(() => false),
  sendOwnerChannelChecked: vi.fn(async () => 'no_channel'),
}))

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}
function mkRes(): MockRes {
  return {
    statusCode: 0, headers: {}, body: '',
    writeHead(status, headers) { this.statusCode = status; if (headers) Object.assign(this.headers, headers); return this },
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}
async function call(method: string, path: string, opts: { body?: unknown; auth?: RouteContext['auth']; ip?: string; headers?: Record<string, string> } = {}) {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = { ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}), ...(opts.headers ?? {}) }
  const res = mkRes()
  const ctx: RouteContext = {
    req: req as http.IncomingMessage, res: res as unknown as http.ServerResponse,
    path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth: opts.auth,
  } as RouteContext
  await tryHandleAuth(ctx)
  return { status: res.statusCode, body: res.body, headers: res.headers, json: () => JSON.parse(res.body || '{}') }
}

let sent: string[] = []
let ipSeq = 0
const nextIp = () => `10.0.0.${++ipSeq}`
const codeOf = (text: string) => /(\d{6})/.exec(text)![1]!

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(async () => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users; DELETE FROM config_change_log')
  try { getDb().exec('DELETE FROM password_recovery_codes; DELETE FROM password_recovery_settings') } catch { /* created lazily */ }
  _clearSessionCacheForTest()
  _resetRecoveryState()
  sent = []
  _setRecoveryDeps({ telegramReady: () => true, telegramSend: async (t) => { sent.push(t); return 'sent' }, mail: null })
  createDashboardUser('boss', await hashPassword('old-password-123'))
})

async function requestAndGetCode(ip = nextIp()): Promise<string> {
  const r = await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'telegram' }, ip })
  expect(r.status).toBe(200)
  await new Promise((res) => setTimeout(res, 0))
  expect(sent.length).toBeGreaterThan(0)
  return codeOf(sent[sent.length - 1]!)
}

describe('public paths', () => {
  it('the three steps and the channel list are reachable signed out; settings are not', () => {
    expect(requiresAuth('/api/auth/recovery/channels', 'GET')).toBe(false)
    expect(requiresAuth('/api/auth/recovery/request', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/recovery/verify', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/recovery/complete', 'POST')).toBe(false)
    expect(requiresAuth('/api/auth/recovery/settings', 'GET')).toBe(true)
    expect(requiresAuth('/api/auth/recovery/settings', 'POST')).toBe(true)
  })
})

describe('channel list', () => {
  it('fresh install: nothing connected -> both rows present, neither available', async () => {
    _setRecoveryDeps({ telegramReady: () => false, mail: null })
    const r = await call('GET', '/api/auth/recovery/channels')
    expect(r.json()).toMatchObject({ channels: [{ id: 'telegram', available: false }, { id: 'email', available: false }] })
  })
  it('e-mail becomes available only once a connected mailbox is chosen, and never lists an address', async () => {
    const mail: MailPort = { accounts: () => [{ id: 'acc1', address: 'owner@example.org' }], send: async () => ({ ok: true }) }
    _setRecoveryDeps({ telegramReady: () => true, mail })
    expect((await call('GET', '/api/auth/recovery/channels')).json().channels[1]).toEqual({ id: 'email', available: false })
    const s = await call('POST', '/api/auth/recovery/settings', { auth: { kind: 'session', user: 'boss' }, body: { email_account: 'acc1' } })
    expect(s.status).toBe(200)
    const r = await call('GET', '/api/auth/recovery/channels')
    expect(r.json().channels[1]).toEqual({ id: 'email', available: true })
    expect(r.body).not.toContain('example.org')
  })
  it('a typed-in address is refused as recovery mailbox', async () => {
    _setRecoveryDeps({ mail: { accounts: () => [], send: async () => ({ ok: true }) } })
    const s = await call('POST', '/api/auth/recovery/settings', { auth: { kind: 'session', user: 'boss' }, body: { email_account: 'attacker@evil.test' } })
    expect(s.status).toBe(400)
    expect(s.json().error).toBe('unknown_account')
  })
  it('e-mail code goes from the chosen mailbox to its own address', async () => {
    const calls: { id: string; text: string }[] = []
    const mail: MailPort = { accounts: () => [{ id: 'acc1', address: 'owner@example.org' }], send: async (id, _s, text) => { calls.push({ id, text }); return { ok: true } } }
    _setRecoveryDeps({ telegramReady: () => false, mail })
    await call('POST', '/api/auth/recovery/settings', { auth: { kind: 'session', user: 'boss' }, body: { email_account: 'acc1' } })
    const r = await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'email' }, ip: nextIp() })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 0))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe('acc1')
    expect(calls[0]!.text).toMatch(/\d{6}/)
  })
  it('an unavailable channel is refused (install-level, not per user)', async () => {
    _setRecoveryDeps({ telegramReady: () => false, mail: null })
    const r = await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'telegram' }, ip: nextIp() })
    expect(r.status).toBe(400)
    expect(r.json().error).toBe('channel_unavailable')
  })
})

describe('request does not reveal whether the user exists', () => {
  it('existing and unknown usernames get byte-identical answers; only the real one sends', async () => {
    const a = await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'telegram' }, ip: nextIp() })
    const b = await call('POST', '/api/auth/recovery/request', { body: { username: 'nobody', channel: 'telegram' }, ip: nextIp() })
    expect(a.status).toBe(b.status)
    expect(a.body).toBe(b.body)
    await new Promise((res) => setTimeout(res, 0))
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/ha nem te kérted/i)
  })
  it('the code message carries the "if you did not ask" sentence in English too', async () => {
    await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'telegram', lang: 'en' }, ip: nextIp() })
    await new Promise((res) => setTimeout(res, 0))
    expect(sent[0]).toMatch(/If you did not ask for it/)
  })
})

describe('rate limits', () => {
  it('per client: 1 per minute', async () => {
    const ip = nextIp()
    expect((await call('POST', '/api/auth/recovery/request', { body: { username: 'boss', channel: 'telegram' }, ip })).status).toBe(200)
    const r = await call('POST', '/api/auth/recovery/request', { body: { username: 'other', channel: 'telegram' }, ip })
    expect(r.status).toBe(429)
    expect(Number(r.json().retry_after_s)).toBeGreaterThan(0)
  })
  it('per username across clients: 1 per minute, 5 per hour -- identical for unknown names', async () => {
    for (const name of ['boss', 'ghost']) {
      const t0 = Date.now()
      for (let i = 0; i < 5; i++) {
        expect(requestCode({ username: name, channel: 'telegram', client: nextIp(), lang: 'hu' }, t0 + i * 61_000).status).toBe('accepted')
      }
      expect(requestCode({ username: name, channel: 'telegram', client: nextIp(), lang: 'hu' }, t0 + 5 * 61_000 + 1).status).toBe('rate_limited')
      expect(requestCode({ username: name, channel: 'telegram', client: nextIp(), lang: 'hu' }, t0 + 30_000).status).toBe('rate_limited')
    }
  })
})

describe('the code', () => {
  it('a wrong code is 400 code_invalid, never 401 (#410)', async () => {
    await requestAndGetCode()
    const r = await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code: '000000' }, ip: nextIp() })
    expect(r.status).toBe(400)
    expect(r.json().error).toBe('code_invalid')
  })
  it('is stored only as a hash', async () => {
    const code = await requestAndGetCode()
    const rows = JSON.stringify(getDb().prepare('SELECT * FROM password_recovery_codes').all())
    expect(rows).not.toContain(code)
  })
  it('is single use', async () => {
    const code = await requestAndGetCode()
    const ok = await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code }, ip: nextIp() })
    expect(ok.status).toBe(200)
    expect(ok.json().ticket).toBeTruthy()
    const again = await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code }, ip: nextIp() })
    expect(again.status).toBe(400)
  })
  it('expires after 10 minutes', async () => {
    const t0 = Date.now()
    requestCode({ username: 'boss', channel: 'telegram', client: nextIp(), lang: 'hu' }, t0)
    await new Promise((res) => setTimeout(res, 0))
    const code = codeOf(sent[0]!)
    expect(verifyCode({ username: 'boss', code, client: nextIp() }, t0 + CODE_TTL_MS + 1).status).toBe('invalid')
  })
  it('dies after 5 wrong attempts, even the right code afterwards', async () => {
    const code = await requestAndGetCode()
    const wrong = code === '111111' ? '222222' : '111111'
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code: wrong }, ip: nextIp() })).status).toBe(400)
    }
    const r = await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code }, ip: nextIp() })
    expect(r.status).toBe(400)
  })
  it('a new request replaces the old code', async () => {
    const first = await requestAndGetCode()
    _resetRecoveryState()
    const second = await requestAndGetCode()
    if (first !== second) {
      expect((await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code: first }, ip: nextIp() })).status).toBe(400)
    }
    expect((await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code: second }, ip: nextIp() })).status).toBe(200)
  })
})

describe('completing the reset', () => {
  it('sets the new password, signs in, signs every other session out, writes the audit row', async () => {
    const user = getDashboardUser('boss')!
    const other = createSession({ userId: user.id, username: 'boss' }, { userAgent: null, remoteNote: 'loopback' })
    const code = await requestAndGetCode()
    const v = await call('POST', '/api/auth/recovery/verify', { body: { username: 'boss', code }, ip: nextIp() })
    const ticket = v.json().ticket
    const short = await call('POST', '/api/auth/recovery/complete', { body: { ticket, new_password: 'short' } })
    expect(short.status).toBe(400)
    expect(short.json().error).toBe('password_policy')
    const done = await call('POST', '/api/auth/recovery/complete', { body: { ticket, new_password: 'a-brand-new-pass-42' } })
    expect(done.status).toBe(200)
    expect(String(done.headers['Set-Cookie'])).toContain('mv_session=')
    expect(await verifyPassword('a-brand-new-pass-42', getDashboardUser('boss')!.password_hash)).toBe(true)
    _clearSessionCacheForTest()
    expect(resolveSession(other)).toBeNull()
    expect(getRecentConfigChanges(50).some((r) => r.key === 'security.password_recovery_reset' && r.new_value === 'boss')).toBe(true)
    const reuse = await call('POST', '/api/auth/recovery/complete', { body: { ticket, new_password: 'another-pass-4242' } })
    expect(reuse.status).toBe(400)
  })
})

describe('a new login needs a delivering owner channel (owner TG 6617)', () => {
  const create = (username: string) => call('POST', '/api/auth/users', { auth: { kind: 'token' }, body: { username, password: 'a-long-enough-pass' } })
  it('no channel: 400 channel_required with a human sentence, never 401, and no user is created', async () => {
    _setRecoveryDeps({ telegramSend: async () => 'no_channel' })
    const r = await create('newbie')
    expect(r.status).toBe(400)
    expect(r.json().error).toBe('channel_required')
    expect(r.json().message).toMatch(/Telegram/)
    expect(getDashboardUser('newbie')).toBeUndefined()
  })
  it('the provider rejects the test message: 400 with the actual error', async () => {
    _setRecoveryDeps({ telegramSend: async () => { throw new Error('Forbidden: bot was blocked by the user') } })
    const r = await create('newbie')
    expect(r.status).toBe(400)
    expect(r.json().reason).toBe('send_failed')
    expect(r.json().message).toContain('bot was blocked')
    expect(getDashboardUser('newbie')).toBeUndefined()
  })
  it('the test message is delivered: the login is created', async () => {
    const r = await create('newbie')
    expect(r.status).toBe(201)
    expect(sent.some((t) => t.includes('newbie'))).toBe(true)
  })
})

describe('Overview self-check: a password with no code channel', () => {
  it('fresh install (no login): quiet; login + channel: quiet; login without channel: yellow, never red', async () => {
    const { passwordChannelRows } = await import('../web/system-health.js')
    expect(passwordChannelRows(() => 0, () => false)).toEqual([])
    expect(passwordChannelRows(() => 1, () => true)).toEqual([])
    expect(passwordChannelRows(() => 1, () => false, () => ({ provider: 'telegram', name: 'Telegram' })))
      .toEqual([{ id: 'password_no_channel', status: 'warn', params: { channel: 'Telegram', provider: 'telegram' } }])
    expect(passwordChannelRows(() => { throw new Error('db gone') }, () => false)).toEqual([])
  })
})

// Owner TG 6620: the installer picks Telegram, Slack or Discord. On a Slack
// install nothing on the screen or in the messages may say "Telegram".
describe('the channel is named as the installer chose it (Slack install)', () => {
  const slack = () => ({ provider: 'slack', name: 'Slack' })
  it('the channel list and the settings carry the real name', async () => {
    _setRecoveryDeps({ telegramReady: () => true, telegramSend: async (t) => { sent.push(t); return 'sent' }, mail: null, channelInfo: slack })
    const r = await call('GET', '/api/auth/recovery/channels')
    expect(r.json()).toMatchObject({ channel_provider: 'slack', channel_name: 'Slack' })
    const user = getDashboardUser('boss')!
    const s = await call('GET', '/api/auth/recovery/settings', { auth: { kind: 'session', user: 'boss', userId: user.id } as RouteContext['auth'] })
    expect(s.json()).toMatchObject({ channel_provider: 'slack', channel_name: 'Slack' })
  })
  it('channel_required says Slack and points to the Channel tab, never Telegram (both languages, both reasons)', async () => {
    for (const send of [async () => 'no_channel' as const, async () => { throw new Error('invalid_auth') }]) {
      _setRecoveryDeps({ telegramSend: send, channelInfo: slack })
      for (const lang of ['hu', 'en']) {
        const req = await call('POST', '/api/auth/users', { auth: { kind: 'token' }, body: { username: 'newbie', password: 'a-long-enough-pass' }, headers: { 'x-ui-lang': lang } })
        expect(req.status).toBe(400)
        const msg = req.json().message as string
        expect(msg).toContain('Slack')
        expect(msg).not.toMatch(/telegram/i)
      }
    }
  })
  it('the "password was reset" notice names the channel, not Telegram', async () => {
    const { recoveryDoneNotice } = await import('../web/password-recovery.js')
    _setRecoveryDeps({ channelInfo: slack })
    for (const lang of ['hu', 'en'] as const) {
      const n = recoveryDoneNotice('boss', 'telegram', lang)
      expect(n).toContain('Slack')
      expect(n).not.toMatch(/telegram/i)
    }
  })
  it('the Overview row names Slack and tells the screen which provider to open', async () => {
    const { passwordChannelRows } = await import('../web/system-health.js')
    expect(passwordChannelRows(() => 1, () => false, slack)[0]!.params).toEqual({ channel: 'Slack', provider: 'slack' })
  })
  it('screen texts: only the Telegram-specific "how" line may say Telegram (hu + en)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const f of ['web/lang/hu.js', 'web/lang/en.js']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8')
      const keys = [...src.matchAll(/^\s*'((?:auth\.recovery|auth\.card\.channel|health\.password_no_channel)[\w.]*)':\s*'((?:[^'\\]|\\.)*)'/gm)]
      expect(keys.length).toBeGreaterThan(10)
      for (const [, key, text] of keys) {
        if (key === 'auth.recovery.how_telegram') continue
        expect(text, key).not.toMatch(/telegram/i)
      }
    }
  })
})
