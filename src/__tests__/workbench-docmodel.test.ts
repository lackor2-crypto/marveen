// #441 (v4 spec 1/A, K-1.7 ... K-1.16, K-1.22): dokumentummodell es forrasrendszer.
// A kitalalt teny vagy hivatkozas technikailag ne kerulhessen be: minden
// tenyallitasnak igazolt forrasa van, a tulajdonos kozlese csak a SAJAT
// kattintasaval kerulhet a vegleges iratba.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import {
  addSection, addBlock, updateBlock, addClaim, confirmOwnerClaim, documentCheck, documentOutline, claimStrength,
  updateSection, removeSection, listClaims, type SourceWorld, type SourceRow,
} from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { ensureAgentTables } from '../workbench-agent/sessions.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const P1 = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'

function seedRead(abs: string, name: string, pages: string[]): void {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((t, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, \'text\', NULL, 0)').run(sha, i + 1, t))
}

describe('forrasrendszer', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  let messages: { id: string; content: string; created_at: number }[] = []
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Level/idezes.pdf' ? { abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' } : null),
    ownerMessages: () => messages,
  })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docmodel-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
    const w = createWorkItem({ project_id: pid, title: 'Valaszbeadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Level', 'idezes.pdf'), 'PDF')
    seedRead(join(projDir(), 'Level', 'idezes.pdf'), 'idezes.pdf', ['Seite eins', P1])
    messages = [{ id: 'm1', content: 'A tárgyalás márciusban volt, ezt írd bele.', created_at: 1_790_000_000 }]
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function block(text: string) {
    const s = addSection(itemId, '2. Tényállás')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text, author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    return { section: s.section, block: b.block }
  }

  it('K-1.7/K-1.12: irat-forras gepi ellenorzessel -- igazolt allitas', () => {
    const { block: b } = block('A tárgyalás 2027. március 17-én 10:30-kor lesz.')
    const r = addClaim(itemId, b.id, 'A tárgyalás 2027. március 17-én 10:30-kor lesz.', [
      { kind: 'document', path: 'Level/idezes.pdf', page: 2, quote: 'am 17. März 2027 um 10:30 Uhr' },
    ], world(), 'workbench-agent')
    expect(r.ok && r.claim.strength).toBe('verified')
    expect(r.ok && r.claim.sources[0].verdict).toBe('verified')
  })

  it('ELFOGADAS: hamis oldalszam -- a forras jelolve, az allitas nem igazolt, veglegesiteni nem lehet', () => {
    const { section, block: b } = block('A tárgyalás 2027. március 17-én lesz.')
    const r = addClaim(itemId, b.id, 'A tárgyalás 2027. március 17-én lesz.', [
      { kind: 'document', path: 'Level/idezes.pdf', page: 1, quote: 'am 17. März 2027 um 10:30 Uhr' },
    ], world(), null)
    expect(r.ok && r.claim.sources[0].verdict).toBe('other_page')
    expect(r.ok && r.claim.strength).toBe('unverified')
    updateSection(itemId, section.id, { status: 'done' })
    const c = documentCheck(itemId)
    expect(c.ready).toBe(false)
    expect(c.items.find((i) => i.key === 'quotes_verified')).toMatchObject({ ok: false, count: 0, total: 1 })
  })

  it('ELFOGADAS: irattal nem igazolhato teny -- a tulajdonos kozlese "irat nincs rola"; csak a SAJAT megerositesevel mehet', async () => {
    const { section, block: b } = block('A tárgyalás márciusban volt.')
    const r = addClaim(itemId, b.id, 'A tárgyalás márciusban volt.', [{ kind: 'owner', said: 'A tárgyalás márciusban volt' }], world(), null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.claim.strength).toBe('owner_unconfirmed')
    expect(r.claim.sources[0]).toMatchObject({ verdict: 'recorded', message_id: 'm1', said_at: 1_790_000_000 })
    updateSection(itemId, section.id, { status: 'done' })
    expect(documentCheck(itemId).ready).toBe(false)
    expect(documentCheck(itemId).items.find((i) => i.key === 'owner_statements')).toMatchObject({ ok: false, count: 0, total: 1 })
    // Az agent (tokennel) nem erosithet meg.
    const byAgent = await callWorkbench(`/api/workbench/items/${itemId}/outline/claims/${r.claim.id}/confirm`, 'POST', {}, undefined, { kind: 'token' })
    expect(byAgent.status).toBe(403)
    // A tulajdonos kattintasa: a szoveg es az ido megmarad.
    const byOwner = await callWorkbench(`/api/workbench/items/${itemId}/outline/claims/${r.claim.id}/confirm`, 'POST', {})
    expect(byOwner.status).toBe(200)
    const claim = listClaims(itemId)[0]
    expect(claim.strength).toBe('owner_confirmed')
    expect(claim.sources[0].confirmed_text).toBe('Igen, ezt vállalom, így kerüljön be.')
    expect(claim.sources[0].confirmed_by).toBe('teszt')
    expect(documentCheck(itemId).ready).toBe(true)
  })

  it('a chatben el nem hangzott "kozles" nem rogzul tulajdonosi szokent', () => {
    const { block: b } = block('A felperes elismerte a tartozást.')
    const r = addClaim(itemId, b.id, 'A felperes elismerte a tartozást.', [{ kind: 'owner', said: 'A felperes elismerte a tartozást' }], world(), null)
    expect(r.ok && r.claim.sources[0].verdict).toBe('not_in_chat')
    expect(r.ok && r.claim.strength).toBe('unverified')
  })

  it('K-1.8/K-1.11: a kovetkeztetes nem teny; a hivatalos forras ellenorzesig "ellenorizetlen hivatkozas"', () => {
    const { block: b } = block('A határidő a kézbesítéstől számít. A 8. § szerint ez 15 nap.')
    const base = addClaim(itemId, b.id, 'A határidő a kézbesítéstől számít.', [{ kind: 'document', path: 'Level/idezes.pdf', page: 2, quote: 'Landgericht Berlin' }], world(), null)
    if (!base.ok) throw new Error('alap')
    const inf = addClaim(itemId, b.id, 'A határidő a kézbesítéstől számít.', [{ kind: 'inference', based_on: [base.claim.id] }], world(), null)
    expect(inf.ok && inf.claim.strength).toBe('inference')
    const law = addClaim(itemId, b.id, 'A 8. § szerint ez 15 nap.', [{ kind: 'official', citation: '8. §', url: 'https://net.jogtar.hu/x', quote: '15 nap' }], world(), null)
    expect(law.ok && law.claim.sources[0].verdict).toBe('unverified')
    const c = documentCheck(itemId)
    expect(c.items.find((i) => i.key === 'unverified_references')).toMatchObject({ ok: false, count: 1 })
    expect(c.items.find((i) => i.key === 'inference_as_fact')).toMatchObject({ count: 1 })
  })

  it('K-1.10: forras nelkuli allitas nincs; a hiany-jeloles blokkolja a veglegesitest', () => {
    const { section, block: b } = block('A kézbesítés napja: ⚠ Hiányzó adat: a kézbesítés dátuma.')
    expect(addClaim(itemId, b.id, 'A kézbesítés napja', [], world(), null)).toMatchObject({ ok: false, code: 'bad_input' })
    expect(addClaim(itemId, b.id, 'Ez nincs a szövegben', [{ kind: 'owner', said: 'x y z' }], world(), null)).toMatchObject({ ok: false, code: 'claim_not_in_text' })
    updateSection(itemId, section.id, { status: 'done' })
    const c = documentCheck(itemId)
    expect(c.items.find((i) => i.key === 'missing_data')).toMatchObject({ ok: false, count: 1, detail: ['⚠ Hiányzó adat: a kézbesítés dátuma.'] })
    expect(documentOutline(itemId).sections[0].problems).toBe(1)
  })

  it('K-1.16: kezi atiras -- "te irtad" jeloles; az eltunt mondat allitasa a forrasaval torlodik', () => {
    const { block: b } = block('A tárgyalás 2027. március 17-én lesz. Második mondat.')
    addClaim(itemId, b.id, 'A tárgyalás 2027. március 17-én lesz.', [{ kind: 'document', path: 'Level/idezes.pdf', page: 2, quote: 'am 17. März 2027' }], world(), null)
    const u = updateBlock(itemId, b.id, { text: 'Csak a második mondat maradt.', author: 'owner' })
    expect(u.ok && u.dropped_claims).toBe(1)
    expect(u.ok && u.block.owner_edited_at).toBeTruthy()
    expect(listClaims(itemId)).toEqual([])
    expect(documentCheck(itemId).items.find((i) => i.key === 'owner_written')?.count).toBe(1)
  })

  it('a fejezet torlese a blokkokat es az allitasokat is viszi', () => {
    const { section, block: b } = block('A tárgyalás márciusban volt.')
    addClaim(itemId, b.id, 'A tárgyalás márciusban volt.', [{ kind: 'owner', said: 'A tárgyalás márciusban volt' }], world(), null)
    removeSection(itemId, section.id)
    expect(documentOutline(itemId).sections).toEqual([])
    expect(listClaims(itemId)).toEqual([])
  })

  it('az ero sorrendje: igazolt irat > megerositett kozles > megerositetlen > kovetkeztetes', () => {
    const src = (kind: string, verdict: string, confirmed: number | null = null) => ({ kind, verdict, confirmed_at: confirmed }) as unknown as SourceRow
    expect(claimStrength([src('owner', 'recorded'), src('document', 'verified')])).toBe('verified')
    expect(claimStrength([src('owner', 'recorded', 1), src('document', 'not_found')])).toBe('owner_confirmed')
    expect(claimStrength([src('inference', 'inference')])).toBe('inference')
    expect(claimStrength([src('document', 'pending')])).toBe('unverified')
  })

  it('az agent eszkozei: doc.* (iro kategoria), a vegen doc.check; megerosito eszkoz NINCS', () => {
    ensureAgentTables()
    expect(getTool('doc.addClaim')?.autonomyCategory).toBe('marveen_selfdev')
    expect(getTool('doc.check')?.autonomyCategory).toBe(null)
    expect(getTool('doc.confirmClaim')).toBeUndefined()
    const ctx = { projectId: pid, workItemId: itemId, lang: 'hu' as const }
    const s = executeTool('doc.addSection', { title: '1. Bevezetés' }, ctx)
    expect(s.ok).toBe(true)
    const sid = s.ok ? (s.data as { id: string }).id : ''
    const b = executeTool('doc.addBlock', { section: sid, text: 'A per tárgya a 2026-os bérleti díj.' }, ctx)
    const bid = b.ok ? (b.data as { id: string }).id : ''
    const c = executeTool('doc.addClaim', { block: bid, text: 'a 2026-os bérleti díj', sources: [{ kind: 'document', path: 'Birosagi/nincs.pdf', page: 1, quote: 'Miete 2026' }] }, ctx)
    expect(c.ok && (c.data as { strength: string }).strength).toBe('unverified')
    const chk = executeTool('doc.check', {}, ctx)
    expect(chk.ok && (chk.data as { ready: boolean }).ready).toBe(false)
    const o = executeTool('doc.outline', {}, ctx)
    expect(o.ok && (o.data as { sections: unknown[] }).sections).toHaveLength(1)
  })

  it('a munkadarab reszletei a vazlatot is adjak; a tulajdonos kezzel is szerkeszthet', async () => {
    const d0 = await callWorkbench(`/api/workbench/items/${itemId}`, 'GET')
    expect(d0.body.outline).toBe(null)
    const s = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections`, 'POST', { title: '1. Bevezetés' })
    expect(s.status).toBe(201)
    const sid = s.body.outline.sections[0].id
    const b = await callWorkbench(`/api/workbench/items/${itemId}/outline/blocks`, 'POST', { section: sid, text: 'Tisztelt Bíróság!' })
    expect(b.body.outline.sections[0].blocks[0]).toMatchObject({ text: 'Tisztelt Bíróság!', author: 'owner' })
    const st = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections/${sid}`, 'PATCH', { status: 'done' })
    expect(st.body.outline.sections[0].status).toBe('done')
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections/${sid}`, 'PATCH', { status: 'kesz' })
    expect(bad.status).toBe(400)
    const d1 = await callWorkbench(`/api/workbench/items/${itemId}`, 'GET')
    expect(d1.body.outline.check.ready).toBe(true)
    expect(project.id).toBe(pid)
  })

  it('a teljes erteku ugynok vegpontja csak doc.* eszkozt enged', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/doc-tool`, 'POST', { tool: 'file.delete', input: {} }, undefined, { kind: 'token' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('doc_tool_unknown')
    const ok = await callWorkbench(`/api/workbench/items/${itemId}/doc-tool`, 'POST', { tool: 'doc.outline', input: {} }, undefined, { kind: 'token' })
    expect(ok.status).toBe(200)
    expect(ok.body.ok).toBe(true)
  })
})

describe('a felulet: vazlat, forrasok, megerosites', () => {
  it('fejezet allapottal es hianyokkal, allitas ikonnal, tulajdonosi megerosito gomb; a gomb a confirm vegpontot hivja', async () => {
    const h = workbenchHarness({ confirm: true })
    const ITEM = { id: 'w1', title: 'Beadvany', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
    const claim = (id: string, strength: string, kind: string, verdict: string) => ({ id, text: 'Állítás ' + id, strength, sources: [{ kind, verdict, path: 'L/a.pdf', page: 2, quote: 'q', said: 'mondtam', said_at: 1, confirmed_at: null }] })
    const OUTLINE = {
      sections: [{
        id: 's1', title: '2. Tényállás', status: 'in_progress', problems: 2,
        blocks: [{ id: 'b1', kind: 'paragraph', text: 'Szöveg. ⚠ Hiányzó adat: a kézbesítés dátuma', owner_edited_at: null, missing: ['⚠ Hiányzó adat: a kézbesítés dátuma'],
          claims: [claim('c1', 'verified', 'document', 'verified'), claim('c2', 'owner_unconfirmed', 'owner', 'recorded')] }],
      }],
      check: { ready: false, items: [{ key: 'sections_done', ok: false, count: 0, total: 1, detail: ['2. Tényállás'] }, { key: 'owner_statements', ok: false, count: 0, total: 1, detail: ['Állítás c2'] }] },
    }
    h.respond((url, init) => {
      if (url.includes('/outline/claims/c2/confirm') && init && init.method === 'POST') return { status: 200, body: { ok: true, outline: OUTLINE } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: OUTLINE } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-outline'))
    const html = h.html()
    expect(html).toContain('2. Tényállás')
    expect(html).toContain('workbench.outline.status.in_progress')
    expect(html).toContain('<mark class="wb-outline-missing">⚠ Hiányzó adat: a kézbesítés dátuma</mark>')
    expect(html).toContain('wb-outline-claim-verified')
    expect(html).toContain('workbench.outline.strength.owner_unconfirmed')
    expect(html).toContain('data-wb-act="outline-claim-confirm" data-wb-claim="c2"')
    expect(html).not.toContain('data-wb-claim="c1"')
    expect(html).toContain('workbench.outline.check.owner_statements')
    expect(html).toContain('workbench.outline.not_ready')
    h.click({ 'data-wb-act': 'outline-claim-confirm', 'data-wb-claim': 'c2' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/claims/c2/confirm'))).toBe(true))
  })
})
