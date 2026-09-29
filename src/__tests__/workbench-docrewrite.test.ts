// #441 (v4 spec 1/A, K-1.20): "egyszerubben" / "hivatalosabban" atiras
// bekezdesenkent. Az agent JAVASOL (doc.proposeRewrite), a bekezdes nem
// valtozik; a tulajdonos sajat kattintasa fogadja el vagy veti el. Latja,
// ha egy forrasolt allitas kiesne, es a regi szovegre szolo javaslat nem
// fogadhato el.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, addClaim, documentOutline, proposeRewrite, updateBlock, removeBlock, type SourceWorld } from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const PAGE = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'
const CLAIM = 'A tárgyalás 2027. március 17-én 10:30-kor lesz.'

describe('atirasi javaslat a dokumentummodellben', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  let blockId = ''
  const saved: Record<string, string | undefined> = {}
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Level/idezes.pdf' ? { abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' } : null),
    ownerMessages: () => [],
  })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docrewrite-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const abs = join(projDir(), 'Level', 'idezes.pdf')
    writeFileSync(abs, 'PDF')
    ensureDocReadTables()
    const sha = sha256OfFile(abs)
    getDb().prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'idezes.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha, DOCREAD_VERSION)
    getDb().prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, ?, \'text\', NULL, 0)').run(sha, PAGE)
    const s = addSection(itemId, '1. Tényállás')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: `Tisztelt Bíróság! Tájékoztatom, hogy ${CLAIM} Kérem ennek figyelembevételét.`, author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    blockId = b.block.id
    const c = addClaim(itemId, blockId, CLAIM, [{ kind: 'document', path: 'Level/idezes.pdf', page: 1, quote: 'am 17. März 2027 um 10:30 Uhr' }], world(), 'workbench-agent')
    if (!c.ok) throw new Error('allitas')
  })
  afterEach(() => {
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']
    else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  const block = () => documentOutline(itemId).sections[0]!.blocks[0]!

  it('a javaslat nem irja at a bekezdest; a vazlatban az eredeti mellett latszik', () => {
    const before = block().text
    const r = proposeRewrite(itemId, blockId, { text: `Tisztelt Bíróság! ${CLAIM} Kérem, vegyék figyelembe.`, style: 'simpler' }, 'workbench-agent')
    expect(r.ok).toBe(true)
    const b = block()
    expect(b.text).toBe(before)
    expect(b.rewrite).toMatchObject({ style: 'simpler', stale: false, would_drop: [], created_by: 'workbench-agent' })
    expect(b.claims).toHaveLength(1)
  })

  it('megmondja, melyik forrasolt allitas esne ki; tablazatot es valtozatlan szoveget nem fogad', () => {
    const r = proposeRewrite(itemId, blockId, { text: 'A tárgyalás márciusban lesz.', style: 'formal' }, null)
    expect(r.ok && r.rewrite.would_drop).toEqual([CLAIM])
    expect(proposeRewrite(itemId, blockId, { text: block().text }, null).ok).toBe(false)
    const s = documentOutline(itemId).sections[0]!
    const t = addBlock(itemId, s.id, { kind: 'table', text: 'a | b\n1 | 2', author: 'agent' })
    if (!t.ok) throw new Error('tablazat')
    const bad = proposeRewrite(itemId, t.block.id, { text: 'a | c\n1 | 2' }, null)
    expect(bad.ok).toBe(false)
    // Uj javaslat felulirja a regit; ismeretlen stilus -> "other".
    proposeRewrite(itemId, blockId, { text: `${CLAIM} Ennyi.`, style: 'weird' }, null)
    expect(block().rewrite?.style).toBe('other')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_rewrites').get()).toEqual({ n: 1 })
  })

  it('elfogadas csak a tulajdonos kattintasaval; utana az uj szoveg all, a javaslat eltunik, az allitas marad', async () => {
    const text = `Tisztelt Bíróság! ${CLAIM} Kérem, vegyék figyelembe.`
    proposeRewrite(itemId, blockId, { text, style: 'simpler' }, 'workbench-agent')
    const url = `/api/workbench/items/${itemId}/outline/blocks/${blockId}/rewrite/accept`
    const agent = await callWorkbench(url, 'POST', {}, undefined, { kind: 'token' })
    expect(agent.status).toBe(403)
    expect(block().rewrite).not.toBe(null)
    const r = await callWorkbench(url, 'POST', {})
    expect(r.status).toBe(200)
    const b = r.body.outline.sections[0].blocks[0]
    expect(b.text).toBe(text)
    expect(b.rewrite).toBe(null)
    expect(b.claims).toHaveLength(1)
    // Az agent irta a szoveget: nem lesz "tulajdonos irta".
    expect(b.owner_edited_at).toBe(null)
  })

  it('ha a bekezdes kozben valtozott, a javaslat elavult es nem fogadhato el; elvetheto', async () => {
    proposeRewrite(itemId, blockId, { text: `${CLAIM} Röviden.`, style: 'simpler' }, null)
    updateBlock(itemId, blockId, { text: `Tisztelt Bíróság! ${CLAIM}`, author: 'owner' })
    expect(block().rewrite?.stale).toBe(true)
    const base = `/api/workbench/items/${itemId}/outline/blocks/${blockId}/rewrite`
    const r = await callWorkbench(`${base}/accept`, 'POST', {})
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('outline_rewrite_stale')
    expect(r.body.message).toContain('megváltozott')
    expect(block().text).toBe(`Tisztelt Bíróság! ${CLAIM}`)
    const d = await callWorkbench(base, 'DELETE')
    expect(d.status).toBe(200)
    expect(block().rewrite).toBe(null)
    expect((await callWorkbench(base, 'DELETE')).status).toBe(404)
  })

  it('a bekezdes torlesevel a javaslata is megy', () => {
    proposeRewrite(itemId, blockId, { text: `${CLAIM} Röviden.` }, null)
    removeBlock(itemId, blockId)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_rewrites').get()).toEqual({ n: 0 })
  })

  it('az agent eszkoze: doc.proposeRewrite, a kieso allitasokrol szol', () => {
    const r = executeTool('doc.proposeRewrite', { block: blockId, text: 'Márciusban tárgyalás lesz.', style: 'simpler' }, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(r.ok).toBe(true)
    const d = r.ok ? r.data as { would_drop: string[]; note: string } : null
    expect(d?.would_drop).toEqual([CLAIM])
    expect(d?.note).toContain('word for word')
    expect(block().text).toContain('Tisztelt Bíróság!')
  })
})

describe('a felulet: atirasi gombok es javaslat', () => {
  const ITEM = { id: 'w1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
  const outline = (rewrite: unknown) => ({
    sections: [{
      id: 's1', title: '1. Kérelem', status: 'done', problems: 0, blocks: [
        { id: 'b1', kind: 'paragraph', text: 'Régi szöveg.', owner_edited_at: null, missing: [], claims: [], rewrite },
        { id: 'b2', kind: 'table', text: 'a | b', owner_edited_at: null, missing: [], claims: [], rewrite: null },
      ],
    }],
    check: { ready: false, items: [] }, content_hash: 'a'.repeat(64), reviewed: false, final: null,
  })

  async function open(rw: unknown) {
    const h = workbenchHarness({ confirm: true })
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/rewrite')) return { status: 200, body: { ok: true, outline: outline(null) } }
      if (url.includes('/agent/message')) return { status: 200, body: {}, stream: { chunks: ['event: done\ndata: {}\n\n'] } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: outline(rw) } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-outline-pdf'))
    return h
  }

  it('szoveges bekezdesnel ket gomb, tablazatnal nincs; a gomb az agentnek szol a chatben', async () => {
    const h = await open(null)
    const html = h.html()
    expect(html).toContain('data-wb-act="outline-rewrite-ask" data-wb-style="simpler" data-wb-block="b1"')
    expect(html).toContain('data-wb-act="outline-rewrite-ask" data-wb-style="formal" data-wb-block="b1"')
    expect(html).not.toContain('data-wb-block="b2" data-wb-sec')
    h.click({ 'data-wb-act': 'outline-rewrite-ask', 'data-wb-style': 'formal', 'data-wb-block': 'b1', 'data-wb-sec': 's1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))
    expect(String(call?.init?.body)).toContain('workbench.outline.rewrite_ask.formal')
    expect(h.toasts.some((x) => x.includes('workbench.outline.rewrite_asked'))).toBe(true)
  })

  it('a javaslat az eredeti alatt, a kieso allitasokkal; elfogadas es elvetes', async () => {
    const h = await open({ style: 'simpler', text: 'Új szöveg.', stale: false, would_drop: ['A tárgyalás márciusban lesz.'], created_at: 1, created_by: 'workbench-agent' })
    const html = h.html()
    expect(html).toContain('wb-outline-rewrite')
    expect(html).toContain('workbench.outline.rewrite_proposal.simpler')
    expect(html).toContain('Új szöveg.')
    expect(html).toContain('A tárgyalás márciusban lesz.')
    expect(html).toContain('data-wb-act="outline-rewrite-accept" data-wb-block="b1"')
    h.click({ 'data-wb-act': 'outline-rewrite-accept', 'data-wb-block': 'b1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/blocks/b1/rewrite/accept') && c.init?.method === 'POST')).toBe(true))
    h.click({ 'data-wb-act': 'outline-rewrite-dismiss', 'data-wb-block': 'b1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => /\/outline\/blocks\/b1\/rewrite(\?|$)/.test(c.url) && c.init?.method === 'DELETE')).toBe(true))
  })

  it('elavult javaslatnal nincs elfogadas gomb, csak elvetes', async () => {
    const h = await open({ style: 'formal', text: 'Új.', stale: true, would_drop: [], created_at: 1, created_by: null })
    const html = h.html()
    expect(html).toContain('wb-outline-rewrite-stale')
    expect(html).toContain('workbench.outline.rewrite_stale')
    expect(html).not.toContain('outline-rewrite-accept')
    expect(html).toContain('data-wb-act="outline-rewrite-dismiss"')
  })
})
