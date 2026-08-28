import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Boss, 2026-08-28 (Telegram 628 + screenshot): his chat showed, in the agent's
// own name and twice over, "You've hit your session limit - resets 1am
// (Europe/Budapest)". He read it as the agent choosing to say that while it
// still had quota left. Measured cause: when the five-hour window runs out the
// platform returns that one English sentence AS the whole assistant turn, the
// turn ends without a reply tool call, and this Stop hook's enforce path
// delivered the last assistant text faithfully -- once per refused turn.
//
// The first fix replaced the banner with a Hungarian sentence. Boss then
// answered the open question (voice message 636, same day): "Csak szolj, amikor
// mar ujra tudsz dolgozni, tehat amikor visszajottel." -- so an outage is now
// reported NOT AT ALL, and the only message about it is the dashboard's wake
// bell once the quota is back.
//
// The self-test in the hook covers the pure decision. This covers what actually
// reaches the chat: WHICH text, and HOW MANY TIMES.
const execFileAsync = promisify(execFile)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'telegram_progress_clear.py')

const CHAT = 4242
const BANNER = "You've hit your session limit · resets 1am (Europe/Budapest)"

let server: Server
let base: string
let sent: Array<{ method: string; body: Record<string, unknown> }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? ''
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') } catch { /* ignore */ }
      sent.push({ method, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()) })
})

/** One Stop-hook turn: a pending placeholder, a transcript whose last assistant
 *  text is `answer`, and the nudge already spent (so we reach the fallback). */
// Async on purpose: the stub Bot API lives in THIS process, so a synchronous
// child-process call would block the event loop and every request would time
// out (65 s of nothing, which is how this test first failed).
async function runTurn(stateDir: string, answer: string, sid = 'sid-1'): Promise<void> {
  const pdir = join(stateDir, 'progress')
  mkdirSync(pdir, { recursive: true })
  writeFileSync(join(pdir, `${sid}.json`), JSON.stringify([{ chat_id: CHAT, message_id: 77 }]))
  writeFileSync(join(pdir, `enforce-${sid}.marker`), '')
  const transcript = join(stateDir, `${sid}.jsonl`)
  writeFileSync(transcript, JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
  }) + '\n')
  const child = execFileAsync('python3', [HOOK], {
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, TELEGRAM_API_BASE: base, MARVEEN_LANG: 'hu' },
    encoding: 'utf-8',
  })
  child.child.stdin?.end(JSON.stringify({ session_id: sid, transcript_path: transcript, stop_hook_active: true }))
  await child
}

function texts(): string[] {
  return sent.filter(s => s.method === 'sendMessage').map(s => String(s.body.text ?? ''))
}

describe('keret-kifutas: mi megy ki a felhasznalonak', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'limit-notice-'))
    // The hook reads the bot token from <state dir>/.env, exactly like the
    // plugin does; without it it stays silent for the wrong reason, so a real
    // token has to be there or every assertion below passes vacuously.
    writeFileSync(join(dir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n')
  })
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  it('kieseskor SEMMI nem megy ki (Boss: csak a visszateresrol szolj)', async () => {
    sent = []
    await runTurn(dir, BANNER)
    expect(texts()).toEqual([])
    // A helyorzot viszont el kell takaritani, kulonben ott marad a
    // "Dolgozom rajta" buborek orokre.
    expect(sent.filter(s => s.method === 'deleteMessage')).toHaveLength(1)
  })

  it('a nyers angol platform-mondat sosem jut ki', async () => {
    sent = []
    await runTurn(dir, BANNER, 'sid-2')
    await runTurn(dir, "You've hit your weekly limit \u00b7 resets Aug 31, 9pm (Europe/Budapest)", 'sid-3')
    // A tipografiai aposztrofos valtozat is banner, nem valasz.
    await runTurn(dir, 'You\u2019ve hit your session limit', 'sid-4')
    expect(texts()).toEqual([])
    expect(texts().join(' ')).not.toContain('hit your')
  })

  it('valodi valasz valtozatlanul megy ki, meg ha emliti is a bannert', async () => {
    sent = []
    const real = `Megneztem: tegnap este ez ment ki neked, "${BANNER}", es ez a hiba.`
    await runTurn(dir, real, 'sid-5')
    expect(texts()).toEqual([real])
  })

  it('a nema ag nem nemitja el a tobbi valaszt sem tobb helyorzonel', async () => {
    sent = []
    await runTurn(dir, 'Kesz, minden zold.', 'sid-6')
    expect(texts()).toEqual(['Kesz, minden zold.'])
  })
})
