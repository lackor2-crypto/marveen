// #501 (Boss TG 2762-2769): (1) the Translate button translates the WHOLE language version on the server --
// every section, a title-only "Új fejezet" too -- instead of a chat request that left the version empty when
// the agent did not answer; a provider failure is said in words. (2) An annex can be uploaded from the computer:
// the file goes into the item's "Mellékletek" folder and straight onto the annex list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, addClaim, documentOutline, type SourceWorld } from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { createVariant, variantInfo, addGlossaryTerm } from '../workbench-doclang.js'
import {
  startVariantTranslation, translateJobState, waitForTranslationForTest, setTranslateCallerForTest, resetTranslateJobsForTest,
  buildTranslatePrompt, parseTranslation, type TranslateCaller,
} from '../workbench-doclang-translate.js'
import { egressLog } from '../workbench-privacy.js'
import { listWorkItemAssets } from '../workbench-assets.js'
import { ol } from '../owner-lang.js'
import { getDb } from '../db.js'
import { clearAIProvidersForTest, registerAIProvider, type AIChunk, type AIProvider } from '../workbench-agent/provider.js'
import { resetUsageManagerForTest, setUsageSnapshotReader } from '../workbench-agent/usage-manager.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const PAGE = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'
const CLAIM = 'A tárgyalás 2027. március 17-én 10:30-kor lesz.'
const CLAIM_DE = 'Die Verhandlung findet am 17. März 2027 um 10:30 Uhr statt.'

describe('parseTranslation / buildTranslatePrompt', () => {
  const src = [{ id: 'b1', kind: 'paragraph', text: 'Egy.', claims: [] }, { id: 'b2', kind: 'list', text: '- a\n- b', claims: [{ id: 'c1', text: 'a' }] }]

  it('takes the JSON even inside a code fence, keeps the original block kinds, pairs blocks by id', () => {
    const r = parseTranslation('```json\n{"title":"Neues Kapitel","blocks":[{"id":"b2","text":"- x\\n- y","claims":[{"source_claim":"c1","text":"x"}]},{"id":"b1","text":"Eins."}]}\n```', src)
    expect(r).toEqual({ ok: true, title: 'Neues Kapitel', blocks: [
      { kind: 'paragraph', text: 'Eins.', claims: [] },
      { kind: 'list', text: '- x\n- y', claims: [{ source_claim: 'c1', text: 'x' }] },
    ] })
  })

  it('a title-only section translates to a title and no blocks', () => {
    expect(parseTranslation('{"title":"New section","blocks":[]}', [])).toEqual({ ok: true, title: 'New section', blocks: [] })
  })

  it('says why an answer cannot be saved: no JSON, missing title, wrong block count, empty block', () => {
    expect(parseTranslation('Sorry, I cannot.', src)).toMatchObject({ ok: false, detail: expect.stringContaining('JSON') })
    expect(parseTranslation('{"blocks":[]}', [])).toMatchObject({ ok: false, detail: expect.stringContaining('title') })
    expect(parseTranslation('{"title":"T","blocks":[{"id":"b1","text":"x"}]}', src)).toMatchObject({ ok: false, detail: expect.stringContaining('2 block') })
    expect(parseTranslation('{"title":"T","blocks":[{"id":"b1","text":" "},{"id":"b2","text":"y"}]}', src)).toMatchObject({ ok: false, detail: expect.stringContaining('empty') })
  })

  it('the prompt names the target language, the placeholder title rule, the glossary and every block and claim id', () => {
    const p = buildTranslatePrompt({ targetLang: 'de', title: 'Új fejezet', blocks: src, glossary: [{ term: 'keresetlevél', translation: 'Klage' }] })
    expect(p.system).toContain('German (Deutsch)')
    expect(p.system).toContain('"Új fejezet"')
    expect(p.system).toContain('"keresetlevél" -> "Klage"')
    const user = JSON.parse(p.user)
    expect(user.title).toBe('Új fejezet')
    expect(user.blocks.map((b: { id: string }) => b.id)).toEqual(['b1', 'b2'])
    expect(user.blocks[1].claims).toEqual([{ id: 'c1', text: 'a' }])
  })
})

describe('whole-document translation and annex upload', () => {
  let depot = ''
  let pid = ''
  let src: WorkItemRow
  let claimId = ''
  const saved: Record<string, string | undefined> = {}
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Level/idezes.pdf' ? { abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' } : null),
    ownerMessages: () => [],
  })
  let calls: { system: string; user: string }[] = []

  /** A fake model: translates by a fixed table, as a real one would answer (JSON). */
  const fakeModel = (over: (user: { title: string; blocks: { id: string; text: string; claims: { id: string }[] }[] }, n: number) => string | null = () => null): TranslateCaller => async (req) => {
    calls.push({ system: req.system, user: req.user })
    const u = JSON.parse(req.user)
    const custom = over(u, calls.length)
    if (custom !== null) return { ok: true, text: custom, account: 'lackor-test', model: 'test-model' }
    const title = u.title === 'Új fejezet' ? 'Neues Kapitel' : u.title === '1. Tényállás' ? '1. Sachverhalt' : `DE ${u.title}`
    const blocks = u.blocks.map((b: { id: string; claims: { id: string }[] }) => ({
      id: b.id, text: `Laut der Klageschrift: ${CLAIM_DE}`, claims: b.claims.map((c) => ({ source_claim: c.id, text: CLAIM_DE })),
    }))
    return { ok: true, text: JSON.stringify({ title, blocks }), account: 'lackor-test', model: 'test-model' }
  }

  beforeEach(() => {
    initDatabase(':memory:')
    resetTranslateJobsForTest()
    calls = []
    depot = mkdtempSync(join(tmpdir(), 'marveen-doclang-tr-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Új bírósági beadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    src = w.item
    const abs = join(projDir(), 'Level', 'idezes.pdf')
    writeFileSync(abs, 'PDF')
    ensureDocReadTables()
    const sha = sha256OfFile(abs)
    getDb().prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'idezes.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha, DOCREAD_VERSION)
    getDb().prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, ?, \'text\', NULL, 0)').run(sha, PAGE)
    // Boss's real case: one section with text, then two title-only "Új fejezet" sections.
    const s = addSection(src.id, '1. Tényállás')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(src.id, s.section.id, { text: `A keresetlevél szerint ${CLAIM}`, author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const c = addClaim(src.id, b.block.id, CLAIM, [{ kind: 'document', path: 'Level/idezes.pdf', page: 1, quote: 'am 17. März 2027 um 10:30 Uhr' }], world(), 'workbench-agent')
    if (!c.ok) throw new Error('allitas')
    claimId = c.claim.id
    addSection(src.id, 'Új fejezet')
    addSection(src.id, 'Új fejezet')
  })
  afterEach(() => {
    setTranslateCallerForTest(null)
    resetTranslateJobsForTest()
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']
    else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  const makeDe = (): WorkItemRow => {
    const r = createVariant(src, 'de', 'teszt')
    if (!r.ok) throw new Error(r.detail)
    return r.item
  }

  it('one start translates EVERY section, the title-only "Új fejezet" ones too; claims keep their source; all current', async () => {
    setTranslateCallerForTest(fakeModel())
    const v = makeDe()
    expect(variantInfo(v.id)!.sections.map((s) => s.state)).toEqual(['untranslated', 'untranslated', 'untranslated'])
    const r = startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
    expect(r).toMatchObject({ ok: true, started: true, job: { running: true, total: 3, done: 0 } })
    await waitForTranslationForTest(v.id)
    expect(translateJobState(v.id)).toMatchObject({ running: false, total: 3, done: 3, failed: [], error: null, claims_not_carried: 0 })
    const out = documentOutline(v.id)
    expect(out.sections.map((s) => s.title)).toEqual(['1. Sachverhalt', 'Neues Kapitel', 'Neues Kapitel'])
    expect(out.sections[0]!.blocks[0]!.claims[0]!.sources[0]).toMatchObject({ kind: 'document', path: 'Level/idezes.pdf', page: 1 })
    expect(out.sections[0]!.blocks[0]!.claims[0]!.text).toBe(CLAIM_DE)
    expect(variantInfo(v.id)!.sections.map((s) => s.state)).toEqual(['current', 'current', 'current'])
    // The original's claim id went to the model so it can be carried.
    expect(calls[0]!.user).toContain(claimId)
    // What went out is in the "what left this item" log (K-1.33), with the account.
    expect(egressLog(v.id).filter((e) => e.service === 'claude')).toHaveLength(3)
    expect(egressLog(v.id)[0]).toMatchObject({ service: 'claude', account: 'lackor-test', status: 'sent' })
    // Nothing left to do: a second start says so instead of calling the model again.
    expect(startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: false, code: 'nothing' })
    expect(calls).toHaveLength(3)
  })

  it('only the untranslated and out-of-date sections are sent again; the glossary goes along', async () => {
    setTranslateCallerForTest(fakeModel())
    addGlossaryTerm(pid, { term: 'keresetlevél', translation: 'Klageschrift', lang: 'de' }, 'owner')
    const v = makeDe()
    startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
    await waitForTranslationForTest(v.id)
    expect(calls[0]!.system).toContain('"keresetlevél" -> "Klageschrift"')
    calls = []
    const secs = documentOutline(src.id).sections
    // The original's 2nd section changes -> only that one is stale.
    addBlock(src.id, secs[1]!.id, { text: 'Új bekezdés.', author: 'owner' })
    expect(variantInfo(v.id)!.sections.map((s) => s.state)).toEqual(['current', 'stale', 'current'])
    startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
    await waitForTranslationForTest(v.id)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.user).blocks[0].text).toBe('Új bekezdés.')
    expect(variantInfo(v.id)!.sections.every((s) => s.state === 'current')).toBe(true)
  })

  it('a provider failure (every account out of quota) stops the job and says it in words; nothing stays silently empty', async () => {
    setTranslateCallerForTest(async () => ({ ok: false, code: 'all_accounts_limited', message: 'Most minden bejelentkezett fiók kerete kimerült.' }))
    const v = makeDe()
    startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
    await waitForTranslationForTest(v.id)
    expect(translateJobState(v.id)).toMatchObject({ running: false, done: 0, error: { code: 'all_accounts_limited', message: 'Most minden bejelentkezett fiók kerete kimerült.' } })
    expect(variantInfo(v.id)!.sections.every((s) => s.state === 'untranslated')).toBe(true)
    expect(egressLog(v.id)[0]).toMatchObject({ service: 'claude', status: 'failed' })
    // The owner can start it again (the button comes back): the job is not stuck "running".
    setTranslateCallerForTest(fakeModel())
    expect(startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: true, started: true })
    await waitForTranslationForTest(v.id)
    expect(translateJobState(v.id)).toMatchObject({ done: 3, error: null })
  })

  it('an unusable answer is asked again once; if it stays unusable the section is named, the others are still translated', async () => {
    // Section 1: bad first, good second. Section 2: bad twice. Section 3: good.
    setTranslateCallerForTest(fakeModel((u, n) => (n === 1 || n === 3 || n === 4 ? 'nem JSON' : null)))
    const v = makeDe()
    startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
    await waitForTranslationForTest(v.id)
    const j = translateJobState(v.id)!
    expect(calls).toHaveLength(5)
    expect(j.done).toBe(2)
    expect(j.failed).toEqual([{ source_section: documentOutline(src.id).sections[1]!.id, title: 'Új fejezet', detail: expect.stringContaining('JSON') }])
    expect(variantInfo(v.id)!.sections.map((s) => s.state)).toEqual(['current', 'untranslated', 'current'])
  })

  it('a second click while it runs does not start a second translation; the original is not a version', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const inner = fakeModel()
    setTranslateCallerForTest(async (req) => { await gate; return inner(req) })
    const v = makeDe()
    expect(startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: true, started: true })
    expect(startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: true, started: false, job: { running: true } })
    release()
    await waitForTranslationForTest(v.id)
    expect(calls).toHaveLength(3)
    expect(startVariantTranslation(src.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: false, code: 'not_variant' })
  })

  it('route: POST .../outline/translate starts it (202), the outline carries the progress; errors are sentences', async () => {
    setTranslateCallerForTest(fakeModel())
    const v = makeDe()
    const r = await callWorkbench(`/api/workbench/items/${v.id}/outline/translate`, 'POST', {})
    expect(r.status).toBe(202)
    expect(r.body).toMatchObject({ ok: true, started: true, job: { total: 3 } })
    await waitForTranslationForTest(v.id)
    const o = await callWorkbench(`/api/workbench/items/${v.id}/outline`, 'GET')
    expect(o.body.outline.translate_job).toMatchObject({ running: false, done: 3, total: 3 })
    expect(o.body.outline.sections.map((s: { title: string }) => s.title)).toEqual(['1. Sachverhalt', 'Neues Kapitel', 'Neues Kapitel'])
    const again = await callWorkbench(`/api/workbench/items/${v.id}/outline/translate?lang=hu`, 'POST', {})
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ error: 'translate_nothing', message: expect.stringContaining('naprakész') })
    const orig = await callWorkbench(`/api/workbench/items/${src.id}/outline/translate?lang=en`, 'POST', {})
    expect(orig.status).toBe(400)
    expect(orig.body).toMatchObject({ error: 'translate_not_variant', message: expect.stringContaining('language version') })
    // The original is not touched; it does not carry a job.
    expect((await callWorkbench(`/api/workbench/items/${src.id}/outline`, 'GET')).body.outline.translate_job).toBeNull()
  })

  // The REAL model call path, with a stand-in provider under the Workbench's id (no CLI is started).
  const fakeProvider = (opts: { available: boolean; accounts?: string[]; stream?: (account: string | undefined, user: string) => AIChunk[] }): AIProvider => ({
    id: 'anthropic',
    model: () => 'test-model',
    availability: () => (opts.available ? { available: true } : { available: false, reason: 'not_configured' }),
    accounts: () => opts.accounts || [],
    async *stream(req) { for (const c of (opts.stream ? opts.stream(req.account, req.messages[0]!.content) : [])) yield c },
  })
  const useProvider = (p: AIProvider) => {
    setTranslateCallerForTest(null)
    clearAIProvidersForTest()
    resetUsageManagerForTest()
    setUsageSnapshotReader(() => null)
    registerAIProvider(p)
  }
  const restoreProviders = () => { clearAIProvidersForTest(); setUsageSnapshotReader(null); resetUsageManagerForTest() }

  it('no AI provider on this machine (fresh install): refused at the click, and the reason STAYS in the version\'s state', async () => {
    useProvider(fakeProvider({ available: false }))
    try {
      const v = makeDe()
      const r = await callWorkbench(`/api/workbench/items/${v.id}/outline/translate?lang=hu`, 'POST', {})
      expect(r.status).toBe(424)
      expect(r.body.error).toBe('translate_no_provider')
      expect(r.body.message).toContain('nincs beállítva AI-szolgáltató')
      // After a reload the header still says why -- not a silently empty version.
      const o = await callWorkbench(`/api/workbench/items/${v.id}/outline`, 'GET')
      expect(o.body.outline.translate_job).toMatchObject({ running: false, done: 0, total: 3, error: { code: 'no_provider', message: expect.stringContaining('Claude-fiók') } })
    } finally { restoreProviders() }
  })

  it('the real call path: an account at its limit is skipped, the next one translates; the egress log names it', async () => {
    const seen: (string | undefined)[] = []
    useProvider(fakeProvider({
      available: true, accounts: ['acc-limit', 'acc-ok'],
      stream: (account, user) => {
        seen.push(account)
        if (account === 'acc-limit') return [{ kind: 'error', code: 'limit', detail: 'limit' }]
        const u = JSON.parse(user)
        const blocks = u.blocks.map((b: { id: string; claims: { id: string }[] }) => ({ id: b.id, text: `Laut der Klageschrift: ${CLAIM_DE}`, claims: b.claims.map((c) => ({ source_claim: c.id, text: CLAIM_DE })) }))
        return [{ kind: 'text', text: JSON.stringify({ title: 'Neu', blocks }) }, { kind: 'done', model: 'test-model', via: { kind: 'account', account: 'acc-ok' } }]
      },
    }))
    try {
      const v = makeDe()
      expect(startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })).toMatchObject({ ok: true, started: true })
      await waitForTranslationForTest(v.id)
      expect(translateJobState(v.id)).toMatchObject({ done: 3, error: null, failed: [] })
      expect(seen).toEqual(['acc-limit', 'acc-ok', 'acc-limit', 'acc-ok', 'acc-limit', 'acc-ok'])
      expect(egressLog(v.id).filter((e) => e.service === 'claude').every((e) => e.account === 'acc-ok' && e.status === 'sent')).toBe(true)
    } finally { restoreProviders() }
  })

  it('the real call path: every account at its limit -> the job stops with the "every account is out of quota" sentence', async () => {
    useProvider(fakeProvider({ available: true, accounts: ['a1', 'a2'], stream: () => [{ kind: 'error', code: 'limit', detail: 'limit' }] }))
    try {
      const v = makeDe()
      startVariantTranslation(v.id, { lang: 'hu', by: 'owner' })
      await waitForTranslationForTest(v.id)
      expect(translateJobState(v.id)).toMatchObject({ running: false, done: 0, error: { code: 'all_accounts_limited', message: expect.stringContaining('kimerült') } })
    } finally { restoreProviders() }
  })

  it('annex upload: the file lands in the item folder\'s "Mellékletek" folder, becomes a material AND the next annex', async () => {
    const base = `/api/workbench/items/${src.id}/outline/annexes/upload`
    const pdf = Buffer.from('%PDF-1.4 bérleti szerződés')
    const r = await callWorkbench(`${base}?name=${encodeURIComponent('Bérleti szerződés.pdf')}&title=${encodeURIComponent('Bérleti szerződés, 2024. május 2.')}`, 'POST', pdf, { 'content-type': 'application/pdf' })
    expect(r.status).toBe(201)
    const dir = ol('Mellékletek', 'Attachments')
    expect(r.body.path).toMatch(new RegExp(`/${dir}/Bérleti szerződés\\.pdf$`))
    const folder = getWorkItem(src.id)!.folder as string
    expect(r.body.path).toBe(`${folder}/${dir}/Bérleti szerződés.pdf`)
    expect(readFileSync(join(projDir(), ...r.body.path.split('/'))).toString()).toContain('bérleti szerződés')
    expect(r.body.outline.annexes).toEqual([expect.objectContaining({ label: expect.stringContaining('K1'), title: 'Bérleti szerződés, 2024. május 2.', path: r.body.path })])
    expect(listWorkItemAssets(src.id).map((a) => a.name)).toContain('Bérleti szerződés.pdf')
    // No title: the file name is the title. The folder is reused, not made twice.
    const r2 = await callWorkbench(`${base}?name=jegyzokonyv.pdf`, 'POST', Buffer.from('%PDF-1.4 masik'), { 'content-type': 'application/pdf' })
    expect(r2.status).toBe(201)
    expect(r2.body.path).toBe(`${folder}/${dir}/jegyzokonyv.pdf`)
    expect(r2.body.outline.annexes.map((a: { title: string }) => a.title)).toEqual(['Bérleti szerződés, 2024. május 2.', 'jegyzokonyv'])
    expect(existsSync(join(projDir(), ...folder.split('/'), dir))).toBe(true)
    // The same content again: no second copy, and it is already an annex -> said in words.
    const dup = await callWorkbench(`${base}?name=${encodeURIComponent('másolat.pdf')}`, 'POST', pdf, { 'content-type': 'application/pdf' })
    expect(dup.status).toBe(400)
    expect(dup.body).toMatchObject({ error: 'outline_duplicate', message: expect.stringContaining('mellékletek') })
    expect(existsSync(join(projDir(), ...folder.split('/'), dir, 'másolat.pdf'))).toBe(false)
    // An empty upload is refused.
    expect((await callWorkbench(`${base}?name=ures.pdf`, 'POST', Buffer.alloc(0))).status).toBe(400)
  })
})
