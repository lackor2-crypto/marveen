// #772 (3rd point): the Overview self-check says when the OpenRouter credit is low.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openRouterCreditRows, noteCredit402, noteCreditOk, readCreditNote, setCreditNotePathForTest, CREDIT_NOTE_MAX_AGE_MS,
} from '../openrouter-credit-note.js'
import { deriveOpenRouterCreditsView } from '../openrouter-credits.js'
import { openRouterChat, setAiFetch } from '../ai-call.js'

const H = 3600_000
const NOW = 1_800_000_000_000
const empty = { last402At: null, afford: null, lastOkAt: null }

describe('openRouterCreditRows', () => {
  it('says nothing on an install that has neither a measured balance nor a 402', () => {
    expect(openRouterCreditRows(null, empty, NOW)).toEqual([])
  })

  it('a recent 402 with no full-size success since is a warning', () => {
    const r = openRouterCreditRows(null, { last402At: NOW - 3 * H, afford: 1368, lastOkAt: null }, NOW)
    expect(r).toEqual([{ id: 'openrouter_credit_402', status: 'warn', params: { h: 3 } }])
  })

  it('a full-size success after the 402 clears it', () => {
    expect(openRouterCreditRows(null, { last402At: NOW - 3 * H, afford: 1368, lastOkAt: NOW - H }, NOW)).toEqual([])
  })

  it('a 402 older than a week is no longer claimed', () => {
    expect(openRouterCreditRows(null, { last402At: NOW - CREDIT_NOTE_MAX_AGE_MS - 1, afford: null, lastOkAt: null }, NOW)).toEqual([])
  })

  it('the measured balance uses the 90%/95% tiers', () => {
    const bal = (used: number) => deriveOpenRouterCreditsView({ totalCredits: 10, totalUsage: used })
    expect(openRouterCreditRows(bal(9.6), empty, NOW)[0]).toMatchObject({ id: 'openrouter_credit_low', status: 'bad', params: { usd: '0.40', pct: 96 } })
    expect(openRouterCreditRows(bal(9.2), empty, NOW)[0]).toMatchObject({ id: 'openrouter_credit_low', status: 'warn' })
    expect(openRouterCreditRows(bal(2), empty, NOW)).toEqual([{ id: 'openrouter_credit_ok', status: 'ok', params: { usd: '8.00' } }])
    // A normal balance does not hide a fresh 402 (a per-key limit can refuse while the account still has money).
    expect(openRouterCreditRows(bal(2), { last402At: NOW - H, afford: null, lastOkAt: null }, NOW)[0].id).toBe('openrouter_credit_402')
  })
})

describe('the note follows the chat calls', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'credit-note-'))
    file = join(dir, 'store', 'openrouter-credit.json')
    setCreditNotePathForTest(file)
  })
  afterEach(() => {
    setAiFetch(null)
    setCreditNotePathForTest(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a 402, survives a re-read from disk, and a full-size success clears it', () => {
    noteCredit402(1368, NOW)
    setCreditNotePathForTest(file) // forget the memo: read it back from the file
    expect(readCreditNote()).toEqual({ last402At: NOW, afford: 1368, lastOkAt: null })
    noteCreditOk(NOW + 1)
    expect(JSON.parse(readFileSync(file, 'utf-8')).lastOkAt).toBe(NOW + 1)
  })

  it('a note another process wrote is picked up without a restart', async () => {
    expect(readCreditNote().last402At).toBeNull()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'store'), { recursive: true })
    writeFileSync(file, JSON.stringify({ last402At: NOW, afford: null, lastOkAt: null }))
    expect(readCreditNote().last402At).toBe(NOW)
  })

  it('a success with no open 402 writes nothing', () => {
    noteCreditOk(NOW)
    expect(existsSync(file)).toBe(false)
  })

  const reply = (status: number, body: unknown) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) })
  const ok = reply(200, { choices: [{ message: { content: 'kesz' } }] })
  const out = reply(402, { error: { message: 'You requested up to 4000 tokens, but can only afford 1368.' } })

  it('openRouterChat: a 402 retried into an answer still leaves the warning (the credit is still low)', async () => {
    const answers = [out, ok]
    setAiFetch(async () => answers.shift()!)
    const r = await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 4000, title: 't' })
    expect(r.ok).toBe(true)
    const n = readCreditNote()
    expect(n.afford).toBe(1368)
    expect(openRouterCreditRows(null, n, n.last402At! + 1)[0].id).toBe('openrouter_credit_402')
  })

  it('openRouterChat: the next full-size answer clears it', async () => {
    const answers = [out, ok, ok]
    setAiFetch(async () => answers.shift()!)
    await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 4000, title: 't' })
    await openRouterChat({ apiKey: 'k', model: 'm', prompt: 'p', maxTokens: 1000, title: 't' })
    expect(openRouterCreditRows(null, readCreditNote(), Date.now())).toEqual([])
  })
})

describe('every credit row has a Hungarian AND an English text', () => {
  for (const lang of ['hu', 'en']) {
    it(lang, () => {
      const s = readFileSync(`web/lang/${lang}.js`, 'utf-8')
      for (const id of ['openrouter_credit_low', 'openrouter_credit_402', 'openrouter_credit_ok']) {
        expect(s, `${lang}: health.${id}`).toContain(`'health.${id}':`)
        expect(s, `${lang}: health.${id}_action`).toContain(`'health.${id}_action':`)
      }
    })
  }
})
