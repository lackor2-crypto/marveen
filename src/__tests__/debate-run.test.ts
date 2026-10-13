// Debate started from the Workbench (src/debate-run.ts): the server runs the rounds of a two-model
// debate and files them in the SAME log scripts/debate.mjs writes, so the Marvin "Vitaztatas" page
// shows them under the project. OpenRouter, the vault and the token table are stubbed; the log is a real
// file in a temp folder.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'node:fs'

const h = vi.hoisted(() => ({ dir: '', secret: 'sk-test' as string | null, usage: [] as unknown[][] }))

vi.mock('../config.js', async (orig) => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  h.dir = mkdtempSync(join(tmpdir(), 'debate-run-test-'))
  return { ...(await orig<typeof import('../config.js')>()), STORE_DIR: h.dir }
})
vi.mock('../web/vault.js', () => ({ getSecret: () => h.secret }))
vi.mock('../db.js', () => ({ getDb: () => ({ prepare: () => ({ run: (...a: unknown[]) => { h.usage.push(a) } }) }) }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: () => 20 }))

const {
  parseModelSpec, clampAttachments, buildRoundPrompt, buildConcludePrompt, parseConclusion,
  runDebateRound, concludeDebate, loadDebateSession, DEBATE_LOG_PATH,
  DebateInputError, DebateKeyMissingError, MAX_ATTACHMENT_CHARS, MAX_ATTACHMENTS, MAX_ATTACHMENTS_TOTAL_CHARS,
} = await import('../debate-run.js')

const A = 'openai/gpt-5.5'
const B = 'deepseek/deepseek-v4'

type Reply = string | { status: number; error: string } | 'empty'
let replies: Record<string, Reply[]>
let sent: { model: string; user: string; system: string; plugins?: unknown }[]

function logLines(): Record<string, unknown>[] {
  if (!existsSync(DEBATE_LOG_PATH)) return []
  return readFileSync(DEBATE_LOG_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
}

beforeEach(() => {
  h.secret = 'sk-test'
  h.usage = []
  sent = []
  replies = {}
  rmSync(DEBATE_LOG_PATH, { force: true })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    sent.push({ model: body.model, system: body.messages[0].content, user: body.messages[1].content, plugins: body.plugins })
    const queue = replies[body.model] ?? []
    const r = queue.length > 1 ? queue.shift()! : (queue[0] ?? `answer of ${body.model}`)
    if (typeof r === 'object') return { ok: false, status: r.status, json: async () => ({ error: { message: r.error } }) }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: r === 'empty' ? '' : r } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    }
  }))
})

afterEach(() => { vi.unstubAllGlobals() })

describe('tiszta segedek', () => {
  it('a ":online" vegu modell a webkereso bovitmenyt kapja, a vege nelkul', () => {
    expect(parseModelSpec('openai/gpt-5.5:online')).toEqual({ model: 'openai/gpt-5.5', webSearch: true })
    expect(parseModelSpec('openai/gpt-5.5')).toEqual({ model: 'openai/gpt-5.5', webSearch: false })
  })

  it('a segedanyag korlatai: darabszam, fajlonkenti es osszes karakter, ures fajl kimarad', () => {
    expect(clampAttachments('nem tomb')).toEqual([])
    expect(clampAttachments([{ name: 'ures.txt', text: '  ' }, { name: '', text: 'x' }, null])).toEqual([])
    const big = clampAttachments([{ name: 'a.txt', text: 'x'.repeat(MAX_ATTACHMENT_CHARS + 500) }])
    expect(big[0].text).toHaveLength(MAX_ATTACHMENT_CHARS)
    const many = clampAttachments(Array.from({ length: MAX_ATTACHMENTS + 4 }, (_, i) => ({ name: `f${i}`, text: 'y' })))
    expect(many).toHaveLength(MAX_ATTACHMENTS)
    const total = clampAttachments(Array.from({ length: 8 }, (_, i) => ({ name: `g${i}`, text: 'z'.repeat(MAX_ATTACHMENT_CHARS) })))
    expect(total.reduce((n, a) => n + a.text.length, 0)).toBeLessThanOrEqual(MAX_ATTACHMENTS_TOTAL_CHARS)
  })

  it('az 1. kor onallo valasz; a tovabbi kor a masik allaspontjat es az iranyt is tartalmazza', () => {
    const base = { question: 'Jo a level?', attachments: [{ name: 'level.docx', text: 'Kedves Hatosag' }], own: null, other: null, steer: '' }
    const r1 = buildRoundPrompt({ ...base, round: 1 })
    expect(r1).toContain('Jo a level?')
    expect(r1).toContain('<material name="level.docx">')
    expect(r1).toContain('Kedves Hatosag')
    expect(r1).toContain('answer on your own')
    expect(r1).not.toContain('other model')
    const r2 = buildRoundPrompt({ ...base, round: 2, own: 'SAJAT-ALLASPONT', other: 'MASIK-ALLASPONT', steer: 'A hataridore figyeljetek' })
    expect(r2).toContain('SAJAT-ALLASPONT')
    expect(r2).toContain('MASIK-ALLASPONT')
    expect(r2).toContain('A hataridore figyeljetek')
    expect(r2).toContain('Round 2')
  })

  it('ha az elozo korben a masik nem valaszolt, azt a prompt kimondja (nem uresen hagyja)', () => {
    const r = buildRoundPrompt({ question: 'q', attachments: [], round: 2, own: 'enyem', other: null, steer: '' })
    expect(r).toContain('gave no answer')
    expect(r).not.toContain("owner's note")
  })

  it('a lezaras-prompt az utolso kor allaspontjait es a tulajdonos iranyait adja', () => {
    const p = buildConcludePrompt({
      question: 'q', attachments: [],
      rounds: [
        { round: 1, prompt: 'q', responses: [{ model: A, ok: true, text: 'regi' }] },
        { round: 2, prompt: 'a hataridore', responses: [{ model: A, ok: true, text: 'UTOLSO-A' }, { model: B, ok: false, error: 'x' }] },
      ],
    })
    expect(p).toContain('UTOLSO-A')
    expect(p).not.toContain('regi')
    expect(p).toContain('Round 2: a hataridore')
    expect(p).toContain('CONSENSUS: yes')
  })

  it('a titkar valaszabol a jelzo es a szoveg kulon jon; jelzo nelkul NEM egyetertes', () => {
    expect(parseConclusion('CONSENSUS: yes\nEgyetertettek.')).toEqual({ consensus: true, summary: 'Egyetertettek.' })
    expect(parseConclusion('consensus: NO\n\nNem.')).toEqual({ consensus: false, summary: 'Nem.' })
    expect(parseConclusion('Csak szoveg')).toEqual({ consensus: false, summary: 'Csak szoveg' })
  })
})

describe('kor futtatasa -- ugyanabba a naploba ir, amit a Marvin-oldal olvas', () => {
  it('az 1. kor: egy context sor + modellenkent egy round sor, projekttel, a kozos formaban', async () => {
    const out = await runDebateRound({ project: 'p1', question: 'Jo a level?', models: [A, B], attachments: [{ name: 'l.txt', text: 'tartalom' }] })
    expect(out.round).toBe(1)
    expect(out.responses.map(r => r.model)).toEqual([A, B])
    const lines = logLines()
    expect(lines.map(l => l.type)).toEqual(['context', 'round', 'round'])
    expect(lines[1]).toMatchObject({ session: out.session, round: 1, type: 'round', prompt: 'Jo a level?', model: A, ok: true, text: `answer of ${A}`, tokensIn: 10, tokensOut: 5, project: 'p1' })
    // mindket modell ugyanazt a kerdest + segedanyagot kapta
    expect(sent).toHaveLength(2)
    expect(sent.every(s => s.user.includes('Jo a level?') && s.user.includes('tartalom'))).toBe(true)
    // a fel-hasznalas a "debate" vedrebe kerul
    expect(h.usage).toHaveLength(2)
  })

  it('a kovetkezo kor a tarolt vitabol folytatja: a masik valasza + a tulajdonos iranya megy, a segedanyag nem kell ujra', async () => {
    replies = { [A]: ['A-elso'], [B]: ['B-elso'] }
    const first = await runDebateRound({ project: 'p1', question: 'Kerdes', models: [A, B], attachments: [{ name: 'l.txt', text: 'SEGED' }] })
    sent = []
    replies = { [A]: ['A-masodik'], [B]: ['B-masodik'] }
    const second = await runDebateRound({ session: first.session, steer: 'Menjetek a hatarido fele' })
    expect(second.round).toBe(2)
    const toA = sent.find(s => s.model === A)!.user
    expect(toA).toContain('A-elso')
    expect(toA).toContain('B-elso')
    expect(toA).toContain('Menjetek a hatarido fele')
    expect(toA).toContain('SEGED')
    const toB = sent.find(s => s.model === B)!.user
    expect(toB.indexOf('B-elso')).toBeLessThan(toB.indexOf('A-elso'))
    // a 2. kor sorai a 2. korben, az irannyal; nincs masodik context sor
    const lines = logLines()
    expect(lines.filter(l => l.type === 'context')).toHaveLength(1)
    expect(lines.filter(l => l.round === 2).map(l => l.prompt)).toEqual(['Menjetek a hatarido fele', 'Menjetek a hatarido fele'])
    // es a projekt a 2. kor soraira is rakerul (a Marvin-oldal szuresehez)
    expect(lines.filter(l => l.round === 2).every(l => l.project === 'p1')).toBe(true)
    const st = loadDebateSession(first.session)!
    expect(st.rounds.map(r => r.round)).toEqual([1, 2])
    expect(st.models).toEqual([A, B])
    expect(st.attachments).toEqual([{ name: 'l.txt', text: 'SEGED' }])
  })

  it('ha egy modell hibazik, a kor megmarad a masik valaszaval, a hiba a naploban is ott van', async () => {
    replies = { [B]: [{ status: 429, error: 'rate limited' }] }
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    expect(out.responses.find(r => r.model === B)).toMatchObject({ ok: false, error: 'rate limited' })
    const rows = logLines().filter(l => l.type === 'round')
    expect(rows.find(l => l.model === B)).toMatchObject({ ok: false, text: null, error: 'rate limited' })
    // a kovetkezo kor szol a promptban, hogy a masik nem valaszolt
    sent = []
    replies = {}
    await runDebateRound({ session: out.session })
    expect(sent.find(s => s.model === A)!.user).toContain('gave no answer')
  })

  it('ha MINDKET modell hibazik, a kor nincs naplozva (a tulajdonos ugyanazt ujra probalhatja)', async () => {
    replies = { [A]: [{ status: 500, error: 'down' }], [B]: [{ status: 500, error: 'down' }] }
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    expect(out.responses.every(r => !r.ok)).toBe(true)
    expect(logLines()).toEqual([])
  })

  it('az ures valasz ujraprobalodik (a gpt-5.5 elso hivasa neha ures)', async () => {
    replies = { [A]: ['empty', 'mar van valasz'] }
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    expect(out.responses.find(r => r.model === A)).toMatchObject({ ok: true, text: 'mar van valasz' })
  })

  it('hibas bemenet: nincs kerdes, nem ket kulonbozo modell, ismeretlen vita, hianyzo kulcs', async () => {
    await expect(runDebateRound({ question: '  ', models: [A, B] })).rejects.toMatchObject({ code: 'question_missing' })
    await expect(runDebateRound({ question: 'q', models: [A] })).rejects.toMatchObject({ code: 'two_models_required' })
    await expect(runDebateRound({ question: 'q', models: [A, A] })).rejects.toMatchObject({ code: 'two_models_required' })
    await expect(runDebateRound({ session: 'nincs-ilyen' })).rejects.toBeInstanceOf(DebateInputError)
    h.secret = null
    await expect(runDebateRound({ question: 'q', models: [A, B] })).rejects.toBeInstanceOf(DebateKeyMissingError)
    expect(logLines()).toEqual([])
  })

  it('a ":online" modell a webkereso bovitmenyt kapja', async () => {
    await runDebateRound({ question: 'q', models: [`${A}:online`, B] })
    expect(sent.find(s => s.model === A)!.plugins).toEqual([{ id: 'web' }])
    expect(sent.find(s => s.model === B)!.plugins).toBeUndefined()
  })
})

describe('lezaras', () => {
  it('modell-osszefoglalo: a jelzo kulon jon, a conclude sor a kozos formaban kerul a naplora, utana nem lehet ujabb kor', async () => {
    const out = await runDebateRound({ project: 'p1', question: 'q', models: [A, B] })
    replies = { [A]: ['CONSENSUS: yes\nEgyetertettek a hataridoben.'] }
    const res = await concludeDebate(out.session)
    expect(res).toEqual({ consensus: true, summary: 'Egyetertettek a hataridoben.' })
    expect(logLines().pop()).toMatchObject({ type: 'conclude', session: out.session, consensus: true, summary: 'Egyetertettek a hataridoben.' })
    expect(loadDebateSession(out.session)).toMatchObject({ concluded: true, consensus: true, summary: 'Egyetertettek a hataridoben.' })
    await expect(runDebateRound({ session: out.session })).rejects.toMatchObject({ code: 'session_concluded' })
    await expect(concludeDebate(out.session)).rejects.toMatchObject({ code: 'session_concluded' })
  })

  it('a tulajdonos sajat osszefoglaloja modell-hivas nelkul megy', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    sent = []
    const res = await concludeDebate(out.session, { summary: 'Sajat szoveg', consensus: false })
    expect(res).toEqual({ consensus: false, summary: 'Sajat szoveg' })
    expect(sent).toHaveLength(0)
  })

  it('ha az osszefoglalo-hivas hibazik, a vita nyitva marad', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    replies = { [A]: [{ status: 500, error: 'boom' }] }
    await expect(concludeDebate(out.session)).rejects.toMatchObject({ code: 'summary_failed:boom' })
    expect(loadDebateSession(out.session)!.concluded).toBe(false)
  })
})

describe('egy hibas sor a naploban nem vakitja meg a vitat', () => {
  it('a serult sor kimarad, a tobbi betoltodik', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(DEBATE_LOG_PATH, '{ez nem json\n')
    expect(loadDebateSession(out.session)!.rounds).toHaveLength(1)
  })
})

afterAll(() => { rmSync(h.dir, { recursive: true, force: true }) })
