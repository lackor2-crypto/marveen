// v4 spec 11. pont: a 0., 1/A es 1/B fazis KOTELEZO probaesetei, vegiglancolva.
//
// A 13. pont szerint egy fazis csak akkor zarul, ha a 11. pont probaesete
// lefut, es az 5. fazis csak a 0-2. fazis stabil allapota utan indulhat. A
// reszek kulon-kulon mar tesztelve vannak (agent-routes, assets, docread,
// docmodel, docfinal, deadlines, doclang, courtprofile, redact); itt az a
// kerdes, hogy EGY valos munkamenetkent is vegigmennek-e: ugyanazon a
// munkadarabon, a valodi utvonalakon es a Marvin sajat eszkozein at
// (`executeTool`), valodi irat-olvasassal (pdftotext, szovegfelismeres,
// LibreOffice) -- nem bevetett oldalszoveggel.
//
// A kitakaras-proba (1/B) a `workbench-redact.test.ts`-ben, a 2. fazis
// probaesete a `workbench-routes.test.ts`-ben fut; itt nincs masodik peldanyuk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A chat-esetnel a VALODI Anthropic-szolgaltato is bejegyzodik: egy teszt sose
// inditson valodi modell-hivast (ugyanaz, mint a workbench-agent-routes-ban).
vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return { ...actual, getEffectiveSettingValue: (k: string) => (k.startsWith('WORKBENCH_') ? '' : actual.getEffectiveSettingValue(k)) }
})
vi.mock('../web/claude-plans.js', async (orig) => {
  const actual = await orig<typeof import('../web/claude-plans.js')>()
  return { ...actual, resolveAgentConfigDir: () => ({ configDir: '/nincs/ilyen/claude/konyvtar' }) }
})
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, listWorkItems, getWorkItem } from '../workbench.js'
import { resetRunningForTest, turnKey, isTurnRunning } from '../workbench-agent/orchestrator.js'
import { setUsageSnapshotReader, resetUsageManagerForTest } from '../workbench-agent/usage-manager.js'
import { setAuditWriterForTest } from '../workbench-agent/audit.js'
import { clearAIProvidersForTest, registerAIProvider, type AIChunk, type AICallRequest } from '../workbench-agent/provider.js'
import { resetWorkbenchAgentForTest } from '../workbench-agent/index.js'
import { tryHandleWorkbenchAgent } from '../web/routes/workbench-agent.js'
import type { RouteContext } from '../web/routes/types.js'
import { startDocRead } from '../workbench-docread.js'
import { documentOutline, documentCheck } from '../workbench-docmodel.js'
import { variantInfo, variantsSummary } from '../workbench-doclang.js'
import { getProfile, currentVersion } from '../workbench-courtprofile.js'
import { renderOutlineDocx } from '../workbench-docrender.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

// ---------------------------------------------------------------------------
// Kozos segedek
// ---------------------------------------------------------------------------

const ok = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { encoding: 'utf-8' }).status === 0
/** Az irat-olvasas es a PDF-keszites valodi eszkozei (a CI telepiti oket). */
const HAVE_READERS = ok('pdftotext', ['-v']) && ok('pdftoppm', ['-v']) && ok('tesseract', ['--version'])
const HAVE_SOFFICE = ok('soffice', ['--version'])

/** Kis, de valodi tobboldalas PDF, valodi szovegreteggel (WinAnsi: a nemet ekezetek is). */
function textPdf(pages: string[][], size = 9): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objs: string[] = []
  objs.push('<< /Type /Catalog /Pages 2 0 R >>')
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`)
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  pages.forEach((lines, i) => {
    const content = `BT /F1 ${size} Tf ${size + 5} TL 40 790 Td ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function pdfText(buf: Buffer, dir: string, name: string): string {
  const p = join(dir, name)
  writeFileSync(p, buf)
  return spawnSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf-8' }).stdout
}

/** Egy anyag feltoltese a MEGLEVO munkadarabhoz, a felulet utvonalan at. */
async function upload(itemId: string, name: string, body: Buffer): Promise<{ project_path: string; folder: string }> {
  const r = await callWorkbench(`/api/workbench/items/${itemId}/assets?name=${encodeURIComponent(name)}`, 'POST', body)
  if (r.status !== 201) throw new Error(`feltoltes ${name}: ${r.status} ${JSON.stringify(r.body)}`)
  return { project_path: r.body.asset.project_path, folder: r.body.folder }
}

// ---------------------------------------------------------------------------
// 0. fazis: hosszu keres, elnavigalas, ket sorba allitott uzenet, leallitas
// ---------------------------------------------------------------------------

interface Out { status: number; body: any; raw: string }

function chatCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: Out; leave: () => void } {
  const out: Out = { status: 200, body: null, raw: '' }
  let onClose: (() => void) | null = null
  let gone = false
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    write(chunk: string) { if (!gone) out.raw += chunk; return true },
    end(chunk?: string) { if (chunk && !gone) { out.raw += chunk; try { out.body = JSON.parse(chunk) } catch { /* SSE */ } } },
    on(ev: string, fn: () => void) { if (ev === 'close') onClose = fn; return res },
  }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext,
    out,
    // A felhasznalo elkattint: a bongeszo bontja a kapcsolatot.
    leave: () => { gone = true; onClose?.() },
  }
}

async function chat(path: string, method: string, body?: unknown): Promise<Out> {
  const { ctx, out } = chatCtx(path, method, body)
  await tryHandleWorkbenchAgent(ctx)
  return out
}

function sseEvents(raw: string): { event: string; data: any }[] {
  return raw.split('\n\n').filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1] ?? '',
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}'),
  }))
}

describe('PROBAESET 0. fazis: hosszu keres, elnavigalas, ket sorba allitott uzenet, leallitas', () => {
  let projectId = ''
  let workItemId = ''
  const fetched: string[] = []

  beforeEach(() => {
    initDatabase(':memory:')
    resetRunningForTest()
    resetUsageManagerForTest()
    clearAIProvidersForTest()
    resetWorkbenchAgentForTest()
    setAuditWriterForTest(() => { /* a teszt nem ir a valodi naploba */ })
    setUsageSnapshotReader(() => ({ fiveHour: { usedPct: 12, resetsAt: null }, measuredAt: Date.now(), updatedAt: Date.now() }))
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    projectId = p.project.id
    const w = createWorkItem({ project_id: projectId, title: 'Ajánlat', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    workItemId = w.item.id
    // Minden kimeno HTTP-hivas -- igy latszik, ha barmi a Telegram fele indulna.
    fetched.length = 0
    const realFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(((input: unknown, init?: unknown) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return realFetch(input as RequestInfo, init as RequestInit)
    }) as typeof fetch)
  })

  afterEach(() => {
    setAuditWriterForTest(null)
    setUsageSnapshotReader(null)
    clearAIProvidersForTest()
    resetWorkbenchAgentForTest()
    vi.restoreAllMocks()
  })

  it('nincs elveszett valasz, nincs beragadt zar, semmi nem megy a Telegramra', async () => {
    const key = turnKey(projectId, workItemId)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let midway!: () => void
    const isMidway = new Promise<void>((r) => { midway = r })
    let mode: 'long' | 'echo' | 'until-stopped' = 'long'
    let leave: (() => void) | null = null
    registerAIProvider({
      id: 'teszt', model: () => 'teszt-modell', availability: () => ({ available: true }),
      async *stream(req: AICallRequest) {
        if (mode === 'long') {
          yield { kind: 'text', text: 'Első fele, ' } as AIChunk
          leave?.() // a tulajdonos atkattint egy masik oldalra
          midway()
          await gate // ...es a hosszu munka kozben ket uzenetet is ir
          yield { kind: 'text', text: 'második fele.' } as AIChunk
        } else if (mode === 'echo') {
          const last = [...req.messages].reverse().find((m) => m.role === 'user')
          yield { kind: 'text', text: `Kész: ${String(last?.content ?? '')}` } as AIChunk
        } else {
          yield { kind: 'text', text: 'Dolgozom...' } as AIChunk
          midway()
          await new Promise<void>((r) => { req.signal?.addEventListener('abort', () => r(), { once: true }) })
        }
        yield { kind: 'done', model: 'teszt-modell' } as AIChunk
      },
    })
    const base = { project_id: projectId, work_item_id: workItemId }
    const session = async () => (await chat(`/api/workbench/agent/session?workItem=${workItemId}`, 'GET')).body

    // 1. Hosszu keres; kozben a tulajdonos elnavigal.
    const first = chatCtx('/api/workbench/agent/message', 'POST', { ...base, message: 'Írj egy hosszú ajánlatot.' })
    leave = first.leave
    const running = tryHandleWorkbenchAgent(first.ctx)
    await isMidway
    // Visszajon: a felulet latja, hogy a valasz meg keszul.
    expect((await session()).running).toBe(true)
    expect(isTurnRunning(key)).toBe(true)

    // 2. Ket uzenet a futas kozben: a szerver "foglalt"-tal valaszol, a felulet
    // ezekbol sort allit (workbench-frontend.test.ts, #433 blokk), a beszelgetesbe NEM
    // kerulnek be ketszer, es nem inditanak masodik valaszt.
    const queued = ['Tedd bele a szállítási határidőt is.', 'És a fizetési feltételeket.']
    for (const m of queued) {
      const busy = await chat('/api/workbench/agent/message', 'POST', { ...base, message: m })
      expect(sseEvents(busy.raw).find((e) => e.event === 'error')?.data).toMatchObject({ code: 'busy' })
    }

    // 3. A hosszu valasz befejezodik -- a kapcsolat mar nem el, de a valasz
    // TELJES egeszeben a beszelgetesbe kerul.
    release()
    await running
    expect(first.out.raw).not.toContain('második fele.')
    expect(isTurnRunning(key)).toBe(false)
    let s = await session()
    expect(s.running).toBe(false)
    expect(s.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'Írj egy hosszú ajánlatot.'],
      ['assistant', 'Első fele, második fele.'],
    ])

    // 4. A felulet a vegen sorban elkuldi a ket varakozo uzenetet: mindkettore jon valasz.
    mode = 'echo'
    for (const m of queued) {
      const r = await chat('/api/workbench/agent/message', 'POST', { ...base, message: m })
      expect(sseEvents(r.raw).some((e) => e.event === 'error')).toBe(false)
    }

    // 5. Ujabb hosszu munka, amit a tulajdonos leallit: a SZERVEREN all le, a
    // zar felszabadul, es ami addig elkeszult, az sem vesz el.
    mode = 'until-stopped'
    let midway2!: () => void
    const isMidway2 = new Promise<void>((r) => { midway2 = r })
    midway = midway2
    const long2 = chat('/api/workbench/agent/message', 'POST', { ...base, message: 'Most írd át az egészet.' })
    await isMidway2
    const stop = await chat('/api/workbench/agent/stop', 'POST', base)
    expect(stop.body).toMatchObject({ stopped: true })
    await long2
    expect(isTurnRunning(key)).toBe(false)

    // 6. Nincs beragadt zar: a kovetkezo uzenet rendesen lefut.
    mode = 'echo'
    const after = await chat('/api/workbench/agent/message', 'POST', { ...base, message: 'Köszönöm.' })
    expect(sseEvents(after.raw).some((e) => e.event === 'error')).toBe(false)

    s = await session()
    expect(s.running).toBe(false)
    expect(s.messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
      ['user', 'Írj egy hosszú ajánlatot.'],
      ['assistant', 'Első fele, második fele.'],
      ['user', queued[0]], ['assistant', `Kész: ${queued[0]}`],
      ['user', queued[1]], ['assistant', `Kész: ${queued[1]}`],
      ['user', 'Most írd át az egészet.'], ['assistant', 'Dolgozom...'],
      ['user', 'Köszönöm.'], ['assistant', 'Kész: Köszönöm.'],
    ])
    // Semmi nem ment a Telegram fele (a Munkapad valasza a Munkapad chatjebe megy).
    expect(fetched.filter((u) => u.includes('api.telegram.org'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A dokumentumos esetek kozos kornyezete
// ---------------------------------------------------------------------------

interface DocEnv {
  depot: string
  pid: string
  itemId: string
  ctx: { projectId: string; workItemId: string; lang: 'hu' }
}

function docEnv(): { get: () => DocEnv; setup: (title: string) => void; teardown: () => void } {
  const saved: Record<string, string | undefined> = {}
  let env: DocEnv | null = null
  return {
    get: () => { if (!env) throw new Error('nincs kornyezet'); return env },
    setup(title: string) {
      initDatabase(':memory:')
      const depot = mkdtempSync(join(tmpdir(), 'marveen-acceptance-'))
      mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
      for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
      process.env['MARVEEN_DEPOT'] = depot
      process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
      delete process.env['MARVEEN_SOFFICE']
      resetLibreOfficeProbe()
      const p = createProject({ name: 'Iroda' })
      if (!p.ok) throw new Error('projekt')
      updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
      const w = createWorkItem({ project_id: p.project.id, title, type: 'document' })
      if (!w.ok) throw new Error('munkadarab')
      env = { depot, pid: p.project.id, itemId: w.item.id, ctx: { projectId: p.project.id, workItemId: w.item.id, lang: 'hu' } }
    },
    teardown() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      resetLibreOfficeProbe()
      if (env) rmSync(env.depot, { recursive: true, force: true })
      env = null
    },
  }
}

/** Ugy olvas, ahogy a Marvin: `document.pages`; ha meg keszul, megvarja, es ujra kerdez. */
async function agentReads(e: DocEnv, path: string): Promise<{ pages: number; page_list: { method: string; low: boolean }[] }> {
  const first = executeTool('document.pages', { path }, e.ctx)
  if (!first.ok) {
    expect(first.code, `${path}: ${first.detail}`).toBe('processing')
    const abs = join(e.depot, 'Projektek', 'Iroda', path)
    const s = startDocRead(abs, path.split('/').pop() || path)
    if (s.ok) await s.done
  }
  const again = executeTool('document.pages', { path }, e.ctx)
  if (!again.ok) throw new Error(`${path}: ${again.code} ${again.detail}`)
  return again.data as { pages: number; page_list: { method: string; low: boolean }[] }
}

function verify(e: DocEnv, path: string, page: number, quote: string): { verdict: string; found_on: number[] } {
  const r = executeTool('source.verifyQuote', { path, page, quote }, e.ctx)
  if (!r.ok) throw new Error(`${path}: ${r.code} ${r.detail}`)
  return r.data as { verdict: string; found_on: number[] }
}

// ---------------------------------------------------------------------------
// 0. fazis: 5 vegyes fajl egy MEGLEVO munkadarabhoz
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_READERS || !HAVE_SOFFICE)('PROBAESET 0. fazis: 5 vegyes fajl feltoltese meglevo munkadarabhoz', () => {
  const env = docEnv()
  beforeEach(() => env.setup('Kovács-ügy'))
  afterEach(() => env.teardown())

  it('nincs uj munkadarab, minden fajl a sajat mappaban van, az Agent mindegyikbol idez', async () => {
    const e = env.get()
    const scratch = join(e.depot, 'scratch')
    mkdirSync(scratch)
    // 1. szoveges PDF
    const pdf = textPdf([['Landgericht Berlin', 'Die Klage wird abgewiesen.']])
    // 2. Word-irat (valodi DOCX a LibreOffice-bol)
    const docx = await renderOutlineDocx(
      { sections: [{ title: 'Jegyzőkönyv', status: 'done', blocks: [{ kind: 'paragraph', text: 'A felek a helyszíni bejárás során a hibát közösen rögzítették.' }] }] },
      { title: 'Jegyzőkönyv', author: null, lang: 'hu' },
    )
    if (!docx.ok) throw new Error('docx')
    // 3. lefenykepezett papir (kep, csak szovegfelismeressel olvashato)
    writeFileSync(join(scratch, 'lap.pdf'), textPdf([['Lieferschein', 'Die Ware wurde am Lager vollständig übergeben.']], 16))
    expect(spawnSync('pdftoppm', ['-r', '200', '-png', '-singlefile', join(scratch, 'lap.pdf'), join(scratch, 'lap')]).status).toBe(0)
    const png = readFileSync(join(scratch, 'lap.png'))
    // 4. e-mail
    const eml = Buffer.from([
      'From: Muster GmbH <info@muster.example>',
      'To: Iroda <iroda@example.com>',
      'Subject: Mahnung',
      'Date: Thu, 01 Oct 2026 10:00:00 +0200',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      'Wir bitten um Zahlung der offenen Miete bis Ende des Monats.',
      '',
    ].join('\r\n'), 'utf-8')
    // 5. sajat jegyzet
    const md = Buffer.from('# Jegyzet\n\nAz ügyfél szerint a kulcsátadás szerdán történt.\n', 'utf-8')

    const files: [string, Buffer][] = [
      ['Ítélet.pdf', pdf], ['Jegyzőkönyv.docx', docx.docx], ['Szállítólevél.png', png], ['Felszólítás.eml', eml], ['Jegyzet.md', md],
    ]
    const paths: Record<string, string> = {}
    for (const [name, body] of files) {
      const u = await upload(e.itemId, name, body)
      expect(u.folder).toBe('Munkadarabok/Kovács-ügy')
      paths[name] = u.project_path
    }

    // Nincs uj munkadarab; minden fajl a munkadarab sajat mappajaban, a lemezen is.
    expect(listWorkItems(e.pid)).toHaveLength(1)
    expect(getWorkItem(e.itemId)?.folder).toBe('Munkadarabok/Kovács-ügy')
    for (const [name] of files) {
      expect(paths[name]).toBe(`Munkadarabok/Kovács-ügy/${name}`)
      expect(existsSync(join(e.depot, 'Projektek', 'Iroda', paths[name]!))).toBe(true)
    }
    const detail = await callWorkbench(`/api/workbench/items/${e.itemId}`, 'GET')
    expect(detail.body.assets.map((a: { name: string; present: boolean }) => `${a.name}:${a.present}`))
      .toEqual(files.map(([n]) => `${n}:true`))

    // Az Agent mindegyikbol idez -- a negy iratbol gepileg ellenorzott idezettel.
    const quotes: [string, string, string][] = [
      ['Ítélet.pdf', 'text', 'Die Klage wird abgewiesen.'],
      ['Jegyzőkönyv.docx', 'text', 'a hibát közösen rögzítették'],
      ['Szállítólevél.png', 'ocr', 'Die Ware wurde am Lager vollständig übergeben'],
      ['Felszólítás.eml', 'plain', 'Wir bitten um Zahlung der offenen Miete'],
    ]
    for (const [name, method, quote] of quotes) {
      const ov = await agentReads(e, paths[name]!)
      expect(ov.pages, name).toBeGreaterThanOrEqual(1)
      expect(ov.page_list[0]!.method, name).toBe(method)
      const read = executeTool('document.read', { path: paths[name], from: 1 }, e.ctx)
      expect(read.ok, name).toBe(true)
      expect(JSON.stringify(read.ok ? read.data : null), name).toContain(`[${name}:1]`)
      expect(verify(e, paths[name]!, 1, quote), name).toMatchObject({ verdict: 'verified' })
    }
    // A jegyzet sima szoveg: a file.read adja szo szerint.
    const note = executeTool('file.read', { path: paths['Jegyzet.md'] }, e.ctx)
    expect(note.ok && (note.data as { text: string }).text).toContain('a kulcsátadás szerdán történt')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 1/A es 1/B: valos birosagi level + 2 melleklet -> valaszbeadvany
// ---------------------------------------------------------------------------

const LADUNG = [
  ['Landgericht Berlin', 'Geschäftsnummer: 12 O 345/26', 'In dem Rechtsstreit Muster GmbH gegen Beispiel Kft.', 'Verfügung vom 21. September 2026'],
  [
    'Termin zur mündlichen Verhandlung wird bestimmt auf Dienstag, den 17. März 2027, 10:30 Uhr, Saal 2.',
    'Der Beklagten wird aufgegeben, binnen zwei Wochen nach Zustellung dieser Verfügung Stellung zu nehmen.',
  ],
]
const MIETVERTRAG = [['Mietvertrag', 'Die monatliche Miete beträgt 900 Euro.', 'Die Miete ist bis zum dritten Werktag eines Monats zu zahlen.']]
const ZAHLUNG = [['Kontoauszug', 'Überweisung vom 3. Januar 2026 über 900 Euro an Muster GmbH.']]

interface Brief {
  sections: string[]
  blocks: Record<'intro' | 'rent' | 'paid' | 'request' | 'sign', string>
  claims: Record<'caseNo' | 'hearing' | 'rent' | 'paid', string>
}

describe.skipIf(!HAVE_READERS || !HAVE_SOFFICE)('PROBAESET 1/A es 1/B: birosagi level + 2 melleklet -> valaszbeadvany', () => {
  const env = docEnv()
  let letter = ''
  let lease = ''
  let payment = ''

  beforeEach(async () => {
    env.setup('Válaszbeadvány')
    const e = env.get()
    letter = (await upload(e.itemId, 'Ladung.pdf', textPdf(LADUNG))).project_path
    lease = (await upload(e.itemId, 'Mietvertrag.pdf', textPdf(MIETVERTRAG))).project_path
    payment = (await upload(e.itemId, 'Kontoauszug.pdf', textPdf(ZAHLUNG))).project_path
    for (const p of [letter, lease, payment]) {
      const ov = await agentReads(e, p)
      expect(ov.page_list.every((pg) => pg.method === 'text' && !pg.low), p).toBe(true)
    }
  })
  afterEach(() => env.teardown())

  /** A Marvin munkaja a sajat eszkozeivel: vazlat, forrasolt allitasok, mellekletek. */
  function writeBrief(e: DocEnv): Brief {
    const t = (name: string, input: Record<string, unknown>) => {
      const r = executeTool(name, input, e.ctx)
      if (!r.ok) throw new Error(`${name}: ${r.code} ${r.detail}`)
      return r.data as { id: string; strength?: string }
    }
    const s1 = t('doc.addSection', { title: '1. Tényállás' }).id
    const s2 = t('doc.addSection', { title: '2. Kérelem' }).id
    const intro = t('doc.addBlock', { section: s1, text: 'Tisztelt Bíróság!\nA 12 O 345/26 számú ügyben a tárgyalás 2027. március 17-én 10:30-kor lesz.' }).id
    const rent = t('doc.addBlock', { section: s1, text: 'A bérleti szerződés szerint a havi bérleti díj 900 euró (K1. melléklet).' }).id
    const paid = t('doc.addBlock', { section: s1, text: 'Az alperes 2026. január 3-án 900 eurót utalt át (K2. melléklet).' }).id
    const request = t('doc.addBlock', { section: s2, text: 'Kérem a keresetet elutasítani.' }).id
    const sign = t('doc.addBlock', { section: s2, kind: 'signature', text: 'Budapest, 2026. október 1.\n\nalperes' }).id
    const claim = (block: string, text: string, path: string, page: number, quote: string) => {
      const c = t('doc.addClaim', { block, text, sources: [{ kind: 'document', path, page, quote }] })
      return c.id
    }
    const claims = {
      caseNo: claim(intro, 'A 12 O 345/26 számú ügyben', letter, 1, 'Geschäftsnummer: 12 O 345/26'),
      hearing: claim(intro, 'a tárgyalás 2027. március 17-én 10:30-kor lesz.', letter, 2, 'den 17. März 2027, 10:30 Uhr'),
      rent: claim(rent, 'a havi bérleti díj 900 euró', lease, 1, 'Die monatliche Miete beträgt 900 Euro.'),
      paid: claim(paid, 'Az alperes 2026. január 3-án 900 eurót utalt át', payment, 1, 'Überweisung vom 3. Januar 2026 über 900 Euro'),
    }
    t('doc.addAnnex', { path: lease, title: 'Bérleti szerződés' })
    t('doc.addAnnex', { path: payment, title: 'Átutalási igazolás' })
    for (const s of [s1, s2]) t('doc.updateSection', { section: s, status: 'done' })
    return { sections: [s1, s2], blocks: { intro, rent, paid, request, sign }, claims }
  }

  /** A tulajdonos: megnyitja a piszkozatot (atnezes), majd veglegesit. */
  async function ownerFinalizes(itemId: string): Promise<{ draft: Buffer; fin: Awaited<ReturnType<typeof callWorkbench>> }> {
    const base = `/api/workbench/items/${itemId}/outline`
    const hash = (await callWorkbench(base, 'GET')).body.outline.content_hash as string
    const draft = await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')
    expect(draft.status).toBe(200)
    expect(draft.headers['Content-Type']).toBe('application/pdf')
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    return { draft: draft.raw, fin }
  }

  it('1/A: minden teny forrasolt, az idezet-ellenorzes zold, a hataridok kigyujtve, a piszkozat vizjeles, a vegleges PDF forrasjeloles nelkuli', async () => {
    const e = env.get()
    const brief = writeBrief(e)

    // Minden tenyallitas igazolt forrassal all; a gepi idezet-ellenorzes zold.
    const outline = documentOutline(e.itemId)
    const claims = outline.sections.flatMap((s) => s.blocks.flatMap((b) => b.claims))
    expect(claims).toHaveLength(4)
    for (const c of claims) {
      expect(c.strength, c.text).toBe('verified')
      expect(c.sources.length, c.text).toBeGreaterThan(0)
      expect(c.sources.every((s) => s.verdict === 'verified'), c.text).toBe(true)
    }
    const check = executeTool('doc.check', {}, e.ctx)
    expect(check.ok).toBe(true)
    const cd = check.ok ? check.data as { ready: boolean; items: { key: string; ok: boolean; count: number; total?: number }[] } : null
    expect(cd?.items.filter((i) => !i.ok), JSON.stringify(cd?.items)).toEqual([])
    expect(cd?.ready).toBe(true)
    expect(cd?.items.find((i) => i.key === 'quotes_verified')).toMatchObject({ ok: true, count: 4, total: 4 })
    expect(cd?.items.find((i) => i.key === 'annexes')).toMatchObject({ ok: true, count: 2, total: 2 })

    // A hataridok es idopontok kigyujtve, forrassal (fajl, oldal, mondat).
    const dl = executeTool('doc.deadlines', {}, e.ctx)
    expect(dl.ok).toBe(true)
    const list = dl.ok ? (dl.data as { deadlines: { kind: string; date: string | null; time: string | null; counts_from: unknown; file: string; page: number; quote: string }[] }).deadlines : []
    expect(list.find((d) => d.kind === 'hearing')).toMatchObject({ date: '2027-03-17', time: '10:30', file: letter, page: 2 })
    expect(list.find((d) => d.kind === 'deadline')).toMatchObject({ date: null, counts_from: { amount: 2, unit: 'week', trigger: 'delivery' }, file: letter, page: 2 })
    expect(list.find((d) => d.kind === 'deadline')!.quote).toContain('binnen zwei Wochen nach Zustellung')

    // A tulajdonos: piszkozat (vizjeles), majd vegleges.
    const { draft, fin } = await ownerFinalizes(e.itemId)
    const scratch = mkdtempSync(join(e.depot, 'pdf-'))
    expect(pdfText(draft, scratch, 'draft.pdf')).toContain('PISZKOZAT')
    expect(fin.status, JSON.stringify(fin.body)).toBe(200)
    const finalPdf = readFileSync(join(e.depot, fin.body.file))
    const ft = pdfText(finalPdf, scratch, 'final.pdf')
    expect(ft).toContain('Kérem a keresetet elutasítani.')
    expect(ft).toContain('K1. melléklet')
    // Forrasjeloles nelkul: se fajlnev, se idezet, se belso azonosito, se ikon, se vizjel.
    const leaks = [
      'PISZKOZAT', 'Ladung', 'Mietvertrag.pdf', 'Kontoauszug', '.pdf', 'Source', 'Forrás',
      'Die monatliche Miete', 'Überweisung vom', 'den 17. März 2027', 'Geschäftsnummer',
      '📄', '🗣', '⚖', '💭', e.itemId, ...brief.sections, ...Object.values(brief.claims),
    ]
    for (const leak of leaks) expect(ft, leak).not.toContain(leak)
  }, 240_000)

  it('1/A szandekos hibak: hamis oldalszam, kitalalt teny, kitalalt jogszabaly -- mindharmat jelzi, veglegesiteni nem lehet', async () => {
    const e = env.get()
    const brief = writeBrief(e)
    const t = (name: string, input: Record<string, unknown>) => executeTool(name, input, e.ctx)

    // 1. Hamis oldalszam: az idezet a 2. oldalon all, a hivatkozas az 1.-re mutat.
    expect(verify(e, letter, 1, 'binnen zwei Wochen nach Zustellung')).toMatchObject({ verdict: 'other_page', found_on: [2] })
    const b1 = t('doc.addBlock', { section: brief.sections[0], text: 'Az alperesnek két héten belül kell nyilatkoznia.' })
    const wrongPage = t('doc.addClaim', {
      block: b1.ok ? (b1.data as { id: string }).id : '', text: 'Az alperesnek két héten belül kell nyilatkoznia.',
      sources: [{ kind: 'document', path: letter, page: 1, quote: 'binnen zwei Wochen nach Zustellung' }],
    })
    expect(wrongPage.ok && (wrongPage.data as { strength: string; sources: { verdict: string }[] })).toMatchObject({ strength: 'unverified', sources: [{ verdict: 'other_page' }] })

    // 2. Kitalalt teny: az idezett mondat sehol nincs az iratban.
    const b2 = t('doc.addBlock', { section: brief.sections[0], text: 'Az alperes a bérleti díjat mindig határidőben megfizette.' })
    const invented = t('doc.addClaim', {
      block: b2.ok ? (b2.data as { id: string }).id : '', text: 'Az alperes a bérleti díjat mindig határidőben megfizette.',
      sources: [{ kind: 'document', path: lease, page: 1, quote: 'Die Miete wurde stets pünktlich gezahlt.' }],
    })
    expect(invented.ok && (invented.data as { strength: string; sources: { verdict: string }[] })).toMatchObject({ strength: 'unverified', sources: [{ verdict: 'not_found' }] })

    // 3. Kitalalt jogszabaly: hivatalos forraskent rogzul, de ellenorzesig "ellenorizetlen hivatkozas".
    const b3 = t('doc.addBlock', { section: brief.sections[0], text: 'A BGB 999. §-a szerint a bérleti díj nem esedékes.' })
    const law = t('doc.addClaim', {
      block: b3.ok ? (b3.data as { id: string }).id : '', text: 'A BGB 999. §-a szerint a bérleti díj nem esedékes.',
      sources: [{ kind: 'official', citation: 'BGB § 999', url: 'https://www.gesetze-im-internet.de/bgb/__999.html', quote: 'Die Miete ist nicht fällig.' }],
    })
    expect(law.ok && (law.data as { sources: { verdict: string }[] }).sources[0]!.verdict).toBe('unverified')

    // Mindharom latszik az ellenorzesben -- az Agentnel es a tulajdonos feluleten is.
    const check = t('doc.check', {})
    const items = check.ok ? (check.data as { ready: boolean; items: { key: string; ok: boolean; count: number; detail?: string[] }[] }).items : []
    expect(check.ok && (check.data as { ready: boolean }).ready).toBe(false)
    const quotes = items.find((i) => i.key === 'quotes_verified')!
    expect(quotes.ok).toBe(false)
    expect(quotes.detail).toEqual(expect.arrayContaining([`${letter}:1 -- other_page`, `${lease}:1 -- not_found`]))
    expect(items.find((i) => i.key === 'unverified_references')).toMatchObject({ ok: false, count: 1, detail: ['BGB § 999'] })
    expect(items.find((i) => i.key === 'unsupported_claims')).toMatchObject({ ok: false })
    const owner = await callWorkbench(`/api/workbench/items/${e.itemId}/outline`, 'GET')
    expect(owner.body.outline.check.ready).toBe(false)

    // Veglegesiteni nem lehet: se a tulajdonos (atnezes utan sem), se az Agent.
    const { fin } = await ownerFinalizes(e.itemId)
    expect(fin.status).toBe(409)
    expect(fin.body.error).toBe('outline_not_ready')
    const hash = (await callWorkbench(`/api/workbench/items/${e.itemId}/outline`, 'GET')).body.outline.content_hash
    const byAgent = await callWorkbench(`/api/workbench/items/${e.itemId}/outline/finalize`, 'POST', { accept: true, hash }, undefined, { kind: 'token' })
    expect(byAgent.status).toBe(403)
    expect(owner.body.outline.final).toBe(null)
  }, 240_000)

  it('1/B: ugyanaz angolul es nemetul, utolagos magyar modositas -- elavult valtozatok, a szoszedet ervenyesul, a celbirosag-ellenorzes kiirja a szabalyverziot', async () => {
    const e = env.get()
    const brief = writeBrief(e)
    const t = (name: string, input: Record<string, unknown>) => {
      const r = executeTool(name, input, e.ctx)
      if (!r.ok) throw new Error(`${name}: ${r.code} ${r.detail}`)
      return r.data as Record<string, any>
    }
    // Az ugy szoszedete: a "berleti szerzodes" rogzitett forditasa.
    t('doc.addTerm', { term: 'bérleti szerződés', translation: 'Mietvertrag', lang: 'de' })
    t('doc.addTerm', { term: 'bérleti szerződés', translation: 'lease agreement', lang: 'en' })

    const en = t('doc.createVariant', { lang: 'en' }).item_id as string
    const de = t('doc.createVariant', { lang: 'de' }).item_id as string
    expect(variantsSummary(e.itemId).map((v) => v.lang).sort()).toEqual(['de', 'en'])

    const c = brief.claims
    const tr = (id: string, lang: 'en' | 'de', rentWord: string) => {
      const L = lang === 'en'
        ? {
            s1: '1. Statement of facts', s2: '2. Relief sought',
            intro: ['Dear Court,\nIn case No. 12 O 345/26 the hearing will be held on 17 March 2027 at 10:30.', 'In case No. 12 O 345/26', 'the hearing will be held on 17 March 2027 at 10:30.'],
            rent: [`Under the ${rentWord} the monthly rent is EUR 900 (Exhibit A).`, 'the monthly rent is EUR 900'],
            paid: ['On 3 January 2026 the defendant transferred EUR 900 (Exhibit B).', 'On 3 January 2026 the defendant transferred EUR 900'],
            request: 'I request that the claim be dismissed.', sign: 'Budapest, 1 October 2026\n\nDefendant',
          }
        : {
            s1: '1. Sachverhalt', s2: '2. Antrag',
            intro: ['Sehr geehrte Damen und Herren,\nIm Verfahren 12 O 345/26 findet die Verhandlung am 17. März 2027 um 10:30 Uhr statt.', 'Im Verfahren 12 O 345/26', 'findet die Verhandlung am 17. März 2027 um 10:30 Uhr statt.'],
            rent: [`Nach dem ${rentWord} beträgt die monatliche Miete 900 Euro (Anlage K1).`, 'beträgt die monatliche Miete 900 Euro'],
            paid: ['Die Beklagte hat am 3. Januar 2026 900 Euro überwiesen (Anlage K2).', 'Die Beklagte hat am 3. Januar 2026 900 Euro überwiesen'],
            request: 'Es wird beantragt, die Klage abzuweisen.', sign: 'Budapest, 1. Oktober 2026\n\nBeklagte',
          }
      const one = t('doc.translateSection', {
        id, source_section: brief.sections[0], title: L.s1,
        blocks: [
          { kind: 'paragraph', text: L.intro[0], claims: [{ source_claim: c.caseNo, text: L.intro[1] }, { source_claim: c.hearing, text: L.intro[2] }] },
          { kind: 'paragraph', text: L.rent[0], claims: [{ source_claim: c.rent, text: L.rent[1] }] },
          { kind: 'paragraph', text: L.paid[0], claims: [{ source_claim: c.paid, text: L.paid[1] }] },
        ],
      })
      const two = t('doc.translateSection', {
        id, source_section: brief.sections[1], title: L.s2,
        blocks: [{ kind: 'paragraph', text: L.request }, { kind: 'signature', text: L.sign }],
      })
      return { one, two }
    }

    // A szoszedet ervenyesul: a rogzitettol eltero szo jelzest kap, javitva tiszta.
    const wrong = tr(de, 'de', 'Pachtvertrag')
    expect(wrong.one.glossary_issues).toEqual([{ term: 'bérleti szerződés', translation: 'Mietvertrag' }])
    const right = tr(de, 'de', 'Mietvertrag')
    expect(right.one).toMatchObject({ claims_carried: 4, claims_not_carried: [], glossary_issues: [] })
    expect(tr(en, 'en', 'lease agreement').one).toMatchObject({ claims_carried: 4, claims_not_carried: [], glossary_issues: [] })
    for (const v of [en, de]) expect(variantInfo(v)!.sections.map((s) => s.state)).toEqual(['current', 'current'])
    // A forditott allitas UGYANARRA a forrasra mutat, igazoltan.
    const deClaims = documentOutline(de).sections.flatMap((s) => s.blocks.flatMap((b) => b.claims))
    expect(deClaims.map((x) => x.strength)).toEqual(['verified', 'verified', 'verified', 'verified'])

    // A nemet valtozat: Anlage-szamozas, sajat mellekletjegyzek, nemet celbirosag.
    const deCtx = { ...e.ctx, workItemId: de }
    const tde = (name: string, input: Record<string, unknown>) => {
      const r = executeTool(name, input, deCtx)
      if (!r.ok) throw new Error(`${name}: ${r.code} ${r.detail}`)
      return r.data as Record<string, any>
    }
    tde('doc.annexSettings', { scheme: 'anlage' })
    tde('doc.addAnnex', { path: lease, title: 'Mietvertrag' })
    tde('doc.addAnnex', { path: payment, title: 'Kontoauszug' })
    tde('doc.setCourt', { profile: 'de-ervv' })
    const deCheck = documentCheck(de)
    expect(deCheck.items.filter((i) => !i.ok), JSON.stringify(deCheck.items)).toEqual([])

    // A celbirosag-ellenorzes lefut a kesz fajlokon, es kiirja, melyik szabalyverzio szerint.
    const expected = currentVersion(getProfile('de-ervv')!).version
    const { fin } = await ownerFinalizes(de)
    expect(fin.status, JSON.stringify(fin.body)).toBe(200)
    expect(fin.body.court.check_current).toBe(true)
    expect(fin.body.court.check.result.version).toBe(expected)
    expect(fin.body.court.check.result.profile_id).toBe('de-ervv')
    const court = tde('doc.court', {})
    expect(court.profile).toMatchObject({ id: 'de-ervv', version: expected })
    expect(court.last_check).toMatchObject({ version: expected, for_current_final: true, for_current_rules: true })

    // Utolagos modositas a magyar eredetiben (a tulajdonos kezevel): mindket
    // valtozat erintett fejezete elavult, a nemet nem veglegesitheto ujra.
    const patched = await callWorkbench(`/api/workbench/items/${e.itemId}/outline/blocks/${brief.blocks.paid}`, 'PATCH', {
      text: 'Az alperes 2026. január 3-án 900 eurót utalt át (K2. melléklet). A tartozás így megszűnt.',
    })
    expect(patched.status).toBe(200)
    for (const v of [en, de]) expect(variantInfo(v)!.sections.map((s) => s.state)).toEqual(['stale', 'current'])
    expect(variantsSummary(e.itemId).map((v) => v.stale)).toEqual([1, 1])
    const after = documentCheck(de)
    expect(after.ready).toBe(false)
    expect(after.items.find((i) => i.key === 'variant_current')).toMatchObject({ ok: false, detail: ['1. Tényállás'] })
    const seen = tde('doc.variants', {})
    expect(seen.sections.map((s: { state: string }) => s.state)).toEqual(['stale', 'current'])
  }, 300_000)
})
