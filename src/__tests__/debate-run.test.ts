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
  parseModelSpec, clampAttachments, buildRoundPrompt, buildConcludePrompt, parseConclusion, compareReadings,
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
    // attekintes: a STANDING sor a jelzo utan, nyelvfuggetlenul; a szamok egyediek es nagybetusek
    expect(parseConclusion('CONSENSUS: no\nSTANDING: k1, K 3, K1\nValtoztatas: K1')).toEqual({ consensus: false, summary: 'Valtoztatas: K1', standing: ['K1', 'K3'] })
    expect(parseConclusion('CONSENSUS: yes\nSTANDING: none\nMinden rendben.')).toEqual({ consensus: true, summary: 'Minden rendben.', standing: [] })
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
    expect(res).toMatchObject({ consensus: true, summary: 'Egyetertettek a hataridoben.' })
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

describe('Kotekedo-vedo mod (#597)', () => {
  const OBJ = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.'
  const REPLY = 'K1: ACCEPT\nREASON: igaz\nREWRITE: 15 nap'

  it('az alap az Egyenrangu: a context sor mode=peer, a round sorokon nincs szerep, a hivasok egyszerre mennek', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    const lines = logLines()
    expect(lines[0]).toMatchObject({ type: 'context', mode: 'peer' })
    expect(lines.filter(l => l.type === 'round').every(l => !('role' in l))).toBe(true)
    expect(loadDebateSession(out.session)!.mode).toBe('peer')
    expect(sent.every(s => s.system.includes('two-model debate'))).toBe(true)
  })

  it('ismeretlen mod: hibaval megall, semmi nem keletkezik a naplon', async () => {
    await expect(runDebateRound({ question: 'q', models: [A, B], mode: 'nincs-ilyen' })).rejects.toMatchObject({ code: 'mode_unknown' })
    expect(logLines()).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('az 1. kor: a kotekedo kap elsonek, a vedo a kotekedo ugyanazon kori kifogasait; szerep a naploban, feldolgozott kifogas a valaszban', async () => {
    replies = { [A]: [OBJ], [B]: [REPLY] }
    const out = await runDebateRound({ question: 'Jo a level?', models: [A, B], mode: 'critic' })
    expect(sent.map(s => s.model)).toEqual([A, B])
    expect(sent[0].system).toContain('CRITIC')
    expect(sent[1].system).toContain('DEFENDER')
    expect(sent[1].user).toContain(OBJ)
    expect(out.responses[0]).toMatchObject({ role: 'critic', objections: [{ id: 'K1', kind: 'accuracy', quote: '30 nap' }] })
    expect(out.responses[1]).toMatchObject({ role: 'defender', replies: [{ id: 'K1', verdict: 'accept', rewrite: '15 nap' }] })
    const lines = logLines()
    expect(lines[0]).toMatchObject({ type: 'context', mode: 'critic' })
    expect(lines.filter(l => l.type === 'round').map(l => l.role)).toEqual(['critic', 'defender'])
    // a feldolgozott resz NEM kerul a naplora (csak a nyers szoveg), betoltesnel ujra szamolodik
    expect(lines.filter(l => l.type === 'round').every(l => !('objections' in l) && !('replies' in l))).toBe(true)
    const st = loadDebateSession(out.session)!
    expect(st.mode).toBe('critic')
    expect(st.rounds[0].responses[0].objections).toHaveLength(1)
    expect(st.rounds[0].responses[1].replies).toHaveLength(1)
  })

  it('a kovetkezo kor ugyanazt a modot folytatja, a mod nem kell ujra; a kotekedo latja a sajat kifogasait es a vedo valaszat', async () => {
    replies = { [A]: [OBJ], [B]: [REPLY] }
    const first = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    await runDebateRound({ session: first.session, steer: 'a hatarido fele' })
    expect(sent.map(s => s.model)).toEqual([A, B])
    expect(sent[0].user).toContain(`Your objections in the previous round:\n${OBJ}`)
    expect(sent[0].user).toContain(`The defender's answers in the previous round:\n${REPLY}`)
    expect(sent[0].user).toContain('a hatarido fele')
    expect(sent[1].user).toContain(`Your answers in the previous round:\n${REPLY}`)
    // a masodik kor mod-valasztasa nem irhatja felul a vita modjat
    sent = []
    await runDebateRound({ session: first.session, mode: 'peer' })
    expect(sent[0].system).toContain('CRITIC')
  })

  it('ha a kotekedo nem talal kifogast, a vedot nem hivja (nincs mire valaszolni); a kor igy is mentodik', async () => {
    replies = { [A]: ['NO OBJECTIONS\nMinden adatot ellenoriztem.'] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(sent.map(s => s.model)).toEqual([A])
    expect(out.responses).toHaveLength(1)
    expect(out.responses[0]).toMatchObject({ role: 'critic', noObjections: true })
    expect(logLines().filter(l => l.type === 'round')).toHaveLength(1)
    // a kovetkezo kor a vedonek nincs elozo valasza -- ez nem hiba
    sent = []
    replies = {}
    await runDebateRound({ session: out.session })
    expect(sent.find(s => s.model === B)!.user).toContain('(you gave no answer in the previous round)')
  })

  it('ha a kotekedo hibazik, a vedot nem hivja, a kor nincs naplozva', async () => {
    replies = { [A]: [{ status: 500, error: 'down' }] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(sent.map(s => s.model)).toEqual([A])
    expect(out.responses.every(r => !r.ok)).toBe(true)
    expect(logLines()).toEqual([])
  })

  it('ha a vedo hibazik, a kotekedo kifogasai megmaradnak, a hiba a naploban is ott van', async () => {
    replies = { [A]: [OBJ], [B]: [{ status: 429, error: 'rate limited' }] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(out.responses[1]).toMatchObject({ ok: false, error: 'rate limited' })
    expect(logLines().filter(l => l.type === 'round').map(l => l.ok)).toEqual([true, false])
  })

  it('rosszul formazott valasz nem dob hibat: a nyers szoveg megmarad, feldolgozott resz nelkul', async () => {
    replies = { [A]: ['Szerintem a hatarido pontatlan.'], [B]: ['Igazad van.'] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(out.responses.map(r => r.ok)).toEqual([true, true])
    expect(out.responses[0].objections).toBeUndefined()
    expect(out.responses[1].replies).toBeUndefined()
    expect(out.responses[0].text).toBe('Szerintem a hatarido pontatlan.')
  })

  it('a lezaras-prompt megjeloli a szerepeket, es kimondja, hogy ez atnezes volt', async () => {
    replies = { [A]: [OBJ], [B]: [REPLY] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    replies = { [A]: ['CONSENSUS: no\nvitas marad'] }
    await concludeDebate(out.session)
    expect(sent[0].user).toContain(`### ${A} (critic)`)
    expect(sent[0].user).toContain(`### ${B} (defender)`)
    expect(sent[0].user).toContain('This debate was a review')
  })

  it('az Egyenrangu vita lezaras-promptja valtozatlan: nincs szerep-jeloles', () => {
    const p = buildConcludePrompt({ question: 'q', attachments: [], rounds: [{ round: 1, prompt: 'q', responses: [{ model: A, ok: true, text: 'x' }] }] })
    expect(p).toContain(`### ${A}\nx`)
    expect(p).not.toContain('This debate was a review')
  })
})

describe('Kotekedo-vedo mod: 2-4. fazis (#597)', () => {
  const C = 'openai/gpt-5.5-judge-not-used'
  const OBJ1 = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.'
  const REP1 = 'K1: REJECT\nREASON: szerintem 30'
  const rejectedAgain = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: meg mindig 15.'

  it('a tabla es a tanacs a futtatas eredmenyeben ES a betoltott allapotban is ott van; peer modban nincs', async () => {
    replies = { [A]: [OBJ1], [B]: ['K1: ACCEPT\nREASON: igaz\nREWRITE: 15 nap'] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(out.board).toMatchObject([{ id: 'K1', status: 'accepted', rewrite: '15 nap' }])
    expect(out.boardSummary).toMatchObject({ total: 1, accepted: 1 })
    expect(out.advice).toEqual({ stop: true, reason: 'all_settled' })
    const st = loadDebateSession(out.session)!
    expect(st.board).toHaveLength(1)
    expect(st.advice).toEqual({ stop: true, reason: 'all_settled' })
    const peer = await runDebateRound({ question: 'q', models: [A, B] })
    expect(peer.board).toBeUndefined()
    expect(peer.advice).toBeUndefined()
  })

  it('korbenforgas: ugyanaz a kifogas, ugyanaz az elutasitas masodszor is -> a tanacs: allj meg (de a kor megengedett)', async () => {
    replies = { [A]: [OBJ1, rejectedAgain], [B]: [REP1] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(r1.advice).toEqual({ stop: false })
    const r2 = await runDebateRound({ session: r1.session })
    expect(r2.advice).toEqual({ stop: true, reason: 'stalled' })
    const r3 = await runDebateRound({ session: r1.session })
    expect(r3.round).toBe(3)
  })

  it('a kotekedo az eddigi legnagyobb szam utan szamoz tovabb (K2-tol)', async () => {
    replies = { [A]: [OBJ1], [B]: [REP1] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    await runDebateRound({ session: r1.session })
    expect(sent[0].user).toContain('starting at K2')
  })

  it('a kor-hatar: a beepitett mod 6 kort enged, utana round_limit hiba es semmi nem megy ki', async () => {
    replies = { [A]: [OBJ1], [B]: [REP1] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    for (let i = 2; i <= 6; i++) await runDebateRound({ session: r1.session })
    expect(loadDebateSession(r1.session)!.rounds).toHaveLength(6)
    expect(loadDebateSession(r1.session)!.advice).toMatchObject({ stop: true })
    sent = []
    await expect(runDebateRound({ session: r1.session })).rejects.toMatchObject({ code: 'round_limit' })
    expect(sent).toHaveLength(0)
  })

  it('szerepcsere: a 2. korben a masodik modell a kotekedo (o kezd), az elso a vedo; a szerepek a naploban; a tabla a szerep szerint olvas', async () => {
    replies = { [A]: [OBJ1, 'K1: ACCEPT\nREASON: most mar igen\nREWRITE: 15 nap'], [B]: [REP1, 'K2 [wording]\nQUOTE: "kerjuk"\nOBJECTION: hang'] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', swapRoles: true })
    expect(loadDebateSession(r1.session)).toMatchObject({ swapRoles: true, strength: 'medium' })
    expect(logLines()[0]).toMatchObject({ type: 'context', swapRoles: true, strength: 'medium' })
    sent = []
    const r2 = await runDebateRound({ session: r1.session })
    expect(sent.map(s => s.model)).toEqual([B, A])
    expect(sent[0].system).toContain('CRITIC')
    expect(sent[0].user).toContain('The roles are swapped in this round')
    expect(sent[0].user).toContain(`(written by the other model):\n${OBJ1}`)
    expect(sent[0].user).toContain(`Your answers in the previous round:\n${REP1}`)
    expect(sent[0].user).toContain('starting at K2')
    expect(sent[1].system).toContain('DEFENDER')
    expect(sent[1].user).toContain('before, you wrote the objections')
    expect(r2.responses.map(r => [r.model, r.role])).toEqual([[B, 'critic'], [A, 'defender']])
    // a 3. kor: vissza az eredeti kiosztashoz
    sent = []
    await runDebateRound({ session: r1.session })
    expect(sent.map(s => s.model)).toEqual([A, B])
  })

  it('szerepcsere nelkul (alap) a 2. korben sem cserelnek', async () => {
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    await runDebateRound({ session: r1.session })
    expect(sent.map(s => s.model)).toEqual([A, B])
  })

  it('erosseg: a vitahoz valasztott a kotekedo promptjaba kerul, a naploba kerul, es a tovabbi korok megtartjak', async () => {
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', strength: 'hard' })
    expect(sent[0].system).toContain('Strength: HARD')
    expect(sent[1].system).not.toContain('Strength:')
    expect(loadDebateSession(r1.session)!.strength).toBe('hard')
    sent = []
    await runDebateRound({ session: r1.session, strength: 'mild' })
    expect(sent[0].system).toContain('Strength: HARD') // a 2. kor nem irhatja felul
  })

  it('a biro: a harmadik modell zar, "nem resztvevo" jelzessel; a naplo megnevezi, ki irta; kulon valasztott bironal is', async () => {
    replies = { [A]: [OBJ1], [B]: [REP1] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', judge: C })
    expect(loadDebateSession(r1.session)!.judge).toBe(C)
    sent = []
    replies = { [C]: ['CONSENSUS: no\nA hatarido vitatott.'] }
    const res = await concludeDebate(r1.session)
    expect(sent.map(s => s.model)).toEqual([C, C]) // ket olvasat: elore es forditott sorrendben
    expect(sent[0].user).toContain('You were not one of the two models')
    expect(sent[0].user).toContain('The objection board')
    expect(sent[0].user).toContain('K1 [accuracy] -- status: rejected')
    expect(sent[0].user).toContain('"Changes to make"')
    expect(res).toMatchObject({ consensus: false, by: C })
    expect(logLines().pop()).toMatchObject({ type: 'conclude', by: C })
    expect(loadDebateSession(r1.session)).toMatchObject({ concluded: true, summaryBy: C })
  })

  it('a lezarasnal megadott biro felulirja a vitahoz valasztottat; bironelkul az elso modell ir (a mostani mukodes), nem kulso jelzessel', async () => {
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', judge: C })
    sent = []
    await concludeDebate(r1.session, { judge: B })
    expect(sent.map(s => s.model)).toEqual([B, B])
    expect(sent[0].user).not.toContain('You were not one of the two models')
    const r2 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    await concludeDebate(r2.session)
    expect(sent.map(s => s.model)).toEqual([A, A])
  })

  it('azonos kiadotol szarmazo modellek: figyelmeztetes az eredmenyben (a bironal is)', async () => {
    const same = await runDebateRound({ question: 'q', models: [A, 'openai/gpt-5.5-mini'] })
    expect(same.warnings).toEqual([{ a: A, b: 'openai/gpt-5.5-mini', family: 'openai' }])
    const judged = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', judge: 'deepseek/other' })
    expect(judged.warnings).toEqual([{ a: B, b: 'deepseek/other', family: 'deepseek' }])
    const fine = await runDebateRound({ question: 'q', models: [A, B] })
    expect(fine.warnings).toBeUndefined()
  })

  it('sajat mod: a masolata a vita context-soraban van, ezert a mod szerkesztese/torlese nem valtoztat egy folyo vitat', async () => {
    const { saveStoredMode, deleteStoredMode } = await import('../debate-mode-store.js')
    const saved = saveStoredMode({ name: 'Szigoru', base: 'critic', strength: 'hard', maxRounds: 2, instructions: { critic: 'SAJAT KOTEKEDO SZOVEG' } })
    if (!saved.ok) throw new Error('mod')
    const id = saved.mode.id
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: id })
    expect(sent[0].system).toContain('SAJAT KOTEKEDO SZOVEG')
    expect(sent[0].system).toContain('Strength: HARD') // a mod erossege az alap
    expect(logLines()[0]).toMatchObject({ type: 'context', mode: id, modeDef: { name: 'Szigoru' } })
    expect(loadDebateSession(r1.session)).toMatchObject({ mode: id, modeName: 'Szigoru', maxRounds: 2 })
    // a mod kozben atirva, majd torolve: a folyo vita a sajat masolatat hasznalja
    saveStoredMode({ ...saved.mode, id, instructions: { critic: 'MASIK SZOVEG' }, maxRounds: 5 })
    deleteStoredMode(id)
    sent = []
    await runDebateRound({ session: r1.session })
    expect(sent[0].system).toContain('SAJAT KOTEKEDO SZOVEG')
    expect(sent[0].system).not.toContain('MASIK SZOVEG')
    // a 2 korhatar a masolatbol jon
    await expect(runDebateRound({ session: r1.session })).rejects.toMatchObject({ code: 'round_limit' })
    // uj vita a torolt modbol nem indulhat
    await expect(runDebateRound({ question: 'q', models: [A, B], mode: id })).rejects.toMatchObject({ code: 'mode_unknown' })
  })

  it('egyenrangu sajat mod: a szoveg kiegeszitese az eredeti vita-promptnak, a kor-hivasok egyszerre', async () => {
    const { saveStoredMode } = await import('../debate-mode-store.js')
    const saved = saveStoredMode({ name: 'Nyugodt', base: 'peer', instructions: { peer: 'Legyetek tomorek.' } })
    if (!saved.ok) throw new Error('mod')
    await runDebateRound({ question: 'q', models: [A, B], mode: saved.mode.id })
    expect(sent.every(s => s.system.includes('two-model debate') && s.system.endsWith('Legyetek tomorek.'))).toBe(true)
  })
})

describe('koltsegbecsles a futtato oldalon (#597)', () => {
  const prices = new Map([[A, { promptPrice: 2, completionPrice: 10 }], [B, { promptPrice: 0, completionPrice: 0 }]])

  it('1. kor: mindket modell hivasa; a lezaras becslese meg nincs (nincs mit lezarni)', async () => {
    const { estimateNextRound } = await import('../debate-run.js')
    const e = estimateNextRound({ question: 'k'.repeat(3500), models: [A, B] }, prices)
    expect(e.round).toBe(1)
    expect(e.next.calls.map(c => c.model)).toEqual([A, B])
    expect(e.next.calls[0].tokensIn).toBeGreaterThan(1000)
    expect(e.next.calls[0].usd).toBeGreaterThan(0)
    expect(e.next.calls[1].usd).toBe(0)
    expect(e.conclude).toBeNull()
  })

  it('a kovetkezo kor becslese a mar latott kimenetbol szamol, a lezarase a biro modellel; semmit nem hiv ki', async () => {
    const { estimateNextRound } = await import('../debate-run.js')
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic', judge: 'deepseek/other' })
    const before = sent.length
    const e = estimateNextRound({ session: r1.session }, prices)
    expect(sent.length).toBe(before)
    expect(e.round).toBe(2)
    // a stub minden valasza 5 kimeno token: a becsles azt hasznalja, nem az alapot
    expect(e.next.calls[0].tokensOut).toBe(5)
    expect(e.conclude!.calls[0].model).toBe('deepseek/other')
    expect(e.conclude!.calls[0].usd).toBeNull() // az ar ismeretlen -> nem nulla
    expect(e.conclude!.unpriced).toEqual(['deepseek/other'])
  })

  it('hibak ugyanazok, mint a futtatasnal', async () => {
    const { estimateNextRound } = await import('../debate-run.js')
    expect(() => estimateNextRound({ session: 'nincs' }, prices)).toThrow(DebateInputError)
    expect(() => estimateNextRound({ question: 'q', models: [A], mode: 'critic' }, prices)).toThrow(/two_models_required/)
    expect(() => estimateNextRound({ question: 'q', models: [A, B], mode: 'nincs' }, prices)).toThrow(/mode_unknown/)
  })
})

describe('lezaras: ket olvasat, sorrend-torzitas ellen (#597, 5. fazis)', () => {
  it('az olvasatok osszevetese: a jelzo es (ha mindketto megnevezte) a megallo kifogasok szamitanak; hianyzo STANDING sor csak a jelzore szamit', () => {
    expect(compareReadings({ consensus: true }, { consensus: true })).toMatchObject({ agree: true })
    expect(compareReadings({ consensus: true }, { consensus: false })).toMatchObject({ agree: false })
    expect(compareReadings({ consensus: false, standing: ['K1'] }, { consensus: false })).toMatchObject({ agree: true })
    expect(compareReadings({ consensus: false, standing: ['K1', 'K2'] }, { consensus: false, standing: ['K2', 'K3'] }))
      .toEqual({ agree: false, consensus: [false, false], onlyFirst: ['K1'], onlySecond: ['K3'] })
  })

  const OBJ = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.\n\nK2 [missing]\nQUOTE: "kerjuk"\nOBJECTION: hianyzik az indok.'
  const REP = 'K1: REJECT\nREASON: szerintem 30 nap\n\nK2: ACCEPT\nREASON: tenyleg hianyzik, mert nincs megindokolva\nREWRITE: kerjuk, mert ...'

  it('ugyanaz a vita ket sorrendben megy ki: az allaspontok es a kifogas-tabla megfordul, a szabalyok ugyanazok', async () => {
    replies = { [A]: [OBJ], [B]: [REP] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    sent = []
    replies = { [A]: ['CONSENSUS: no\nSTANDING: K2\nvitas marad'] }
    await concludeDebate(out.session)
    expect(sent).toHaveLength(2)
    const [fwd, rev] = [sent[0].user, sent[1].user]
    expect(fwd.indexOf(`### ${A} (critic)`)).toBeLessThan(fwd.indexOf(`### ${B} (defender)`))
    expect(rev.indexOf(`### ${B} (defender)`)).toBeLessThan(rev.indexOf(`### ${A} (critic)`))
    expect(fwd.indexOf('K1 [accuracy] -- status')).toBeLessThan(fwd.indexOf('K2 [missing] -- status'))
    expect(rev.indexOf('K2 [missing] -- status')).toBeLessThan(rev.indexOf('K1 [accuracy] -- status'))
    for (const u of [fwd, rev]) {
      expect(u).toContain('How sure an argument sounds is not evidence')
      expect(u).toContain('"STANDING: K<n>, K<n>"')
    }
  })

  it('egyezo olvasat: a vizsgalat "egyezik", a naploba kerul, es ujratoltve is ott van; az osszefoglalo a STANDING sor nelkul', async () => {
    replies = { [A]: [OBJ], [B]: [REP] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    replies = { [A]: ['CONSENSUS: no\nSTANDING: K2, K1\nA K2 all.'] }
    const res = await concludeDebate(out.session)
    expect(res.summary).toBe('A K2 all.')
    expect(res.consensus).toBe(false)
    expect(res.orderCheck).toEqual({ agree: true, consensus: [false, false], onlyFirst: [], onlySecond: [] })
    expect(logLines().pop()).toMatchObject({ type: 'conclude', order_check: { agree: true } })
    expect(loadDebateSession(out.session)!.orderCheck).toMatchObject({ agree: true })
  })

  it('a ket olvasat mas konszenzust ad -> a konszenzus "nem", a vizsgalat megmondja, az elso olvasat az iras', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    replies = { [A]: ['CONSENSUS: yes\nEgyetertettek.', 'CONSENSUS: no\nMegsem.'] }
    const res = await concludeDebate(out.session)
    expect(res.consensus).toBe(false)
    expect(res.summary).toBe('Egyetertettek.')
    expect(res.orderCheck).toMatchObject({ agree: false, consensus: [true, false] })
    expect(loadDebateSession(out.session)).toMatchObject({ consensus: false, orderCheck: { agree: false } })
  })

  it('attekintesnel az is elteres, ha mas kifogasok allnak meg a ket olvasatban', async () => {
    replies = { [A]: [OBJ], [B]: [REP] }
    const out = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    replies = { [A]: ['CONSENSUS: yes\nSTANDING: K1\nx', 'CONSENSUS: yes\nSTANDING: K1, K2\ny'] }
    const res = await concludeDebate(out.session)
    expect(res.consensus).toBe(false)
    expect(res.orderCheck).toMatchObject({ agree: false, onlyFirst: [], onlySecond: ['K2'] })
  })

  it('ha a masodik olvasat hibazik, a lezaras megvan, csak a vizsgalat marad ki', async () => {
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    replies = { [A]: ['CONSENSUS: yes\nRendben.', { status: 500, error: 'boom' }] }
    const res = await concludeDebate(out.session)
    expect(res).toMatchObject({ consensus: true, summary: 'Rendben.' })
    expect(res.orderCheck).toBeUndefined()
    expect(loadDebateSession(out.session)).toMatchObject({ concluded: true, orderCheck: null })
  })

  it('a koltsegbecsles ket olvasatot szamol a lezarasra', async () => {
    const { estimateNextRound } = await import('../debate-run.js')
    const out = await runDebateRound({ question: 'q', models: [A, B] })
    const e = estimateNextRound({ session: out.session }, new Map([[A, { promptPrice: 1, completionPrice: 2 }]]))
    expect(e.conclude!.calls).toHaveLength(2)
    expect(e.conclude!.calls[0]).toEqual(e.conclude!.calls[1])
  })
})

describe('gyanus egyetertes (konformitas) a futo vitaban (#597, 5. fazis)', () => {
  const OBJ = 'K1 [accuracy]\nQUOTE: "30 nap"\nOBJECTION: 15 nap a helyes.\n\nK2 [missing]\nQUOTE: "kerjuk"\nOBJECTION: hianyzik az indok.'

  it('a vedo minden kifogast indoklas nelkul elfogad -> a kor eredmenyeben es az allapotban is jelzes', async () => {
    replies = { [A]: [OBJ], [B]: ['K1: ACCEPT\nREASON: igaz\n\nK2: ACCEPT\nREASON: ok'] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(r1.conformity).toEqual({ suspicious: true, round: 1, count: 2 })
    expect(loadDebateSession(r1.session)!.conformity).toEqual({ suspicious: true, round: 1, count: 2 })
  })

  it('indokolt elfogadas, vagy egy elutasitas -> nincs jelzes; az Egyenrangu modban nincs is mezo', async () => {
    replies = { [A]: [OBJ], [B]: ['K1: ACCEPT\nREASON: a hatarido tenyleg 15 nap, ahogy az idezett torveny irja\n\nK2: REJECT\nREASON: ok'] }
    const r1 = await runDebateRound({ question: 'q', models: [A, B], mode: 'critic' })
    expect(r1.conformity).toEqual({ suspicious: false })
    const peer = await runDebateRound({ question: 'q', models: [A, B] })
    expect(peer.conformity).toBeUndefined()
    expect(loadDebateSession(peer.session)!.conformity).toEqual({ suspicious: false })
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
