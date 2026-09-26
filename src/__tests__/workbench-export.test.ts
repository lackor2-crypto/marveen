// #406, 6. pont -- EXPORT (PDF-nyomtathato lap, kep) es KULDES CSAK a
// jovahagyasi kapun at: a szerver es a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listPendingApprovals, getDb } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem, addWorkItemPart } from '../workbench.js'
import { MAIN_AGENT_ID } from '../config.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

describe('a szerver', () => {
  let depot = ''
  let exportsDir = ''
  let pid = ''
  let itemId = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-exp-'))
    exportsDir = join(depot, 'exports-store')
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_WORKBENCH_EXPORTS'] = exportsDir
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('mappa')
    const w = createWorkItem({ project_id: pid, title: 'Nyári <poszt>', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(depot, 'Projektek', 'teszt', 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    addWorkItemPart({ work_item_id: itemId, kind: 'text', text: 'Első bekezdés <b>nem html</b>\n\nMásodik' })
    addWorkItemPart({ work_item_id: itemId, kind: 'image', asset_path: 'Projektek/teszt/foto.png', caption: 'A fotó' })
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
    delete process.env['MARVEEN_WORKBENCH_EXPORTS']
  })

  it('EXPORT: onallo, nyomtathato lap -- a kep BEAGYAZVA, a szoveg escape-elve, nyomtatas-gombbal', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/export.html`, 'GET')
    expect(r.status).toBe(200)
    expect(r.headers['Content-Type']).toMatch(/text\/html/)
    const html = r.raw.toString('utf-8')
    expect(html).toContain('<h1>Nyári &lt;poszt&gt;</h1>')
    expect(html).toContain('Első bekezdés &lt;b&gt;nem html&lt;/b&gt;')
    expect(html).toContain('<p>Második</p>')
    expect(html).toContain('src="data:image/png;base64,iVBORw==')
    expect(html).toContain('<figcaption>A fotó</figcaption>')
    expect(html).toContain('window.print()')
    expect(html).toContain('@media print')
    expect(html).toContain('Projekt: Kovács weboldal')
  })

  it('EXPORT letoltesre: csatolmany-fejlec, nyomtatas-gomb NELKUL; angolul angol', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/export.html?download=1&lang=en`, 'GET')
    expect(r.headers['Content-Disposition']).toMatch(/^attachment; filename\*=UTF-8''/)
    const html = r.raw.toString('utf-8')
    expect(html).not.toContain('window.print()')
    expect(html).toContain('Project: Kovács weboldal')
  })

  it('EXPORT: eltunt kep eseten KIMONDJA, hogy a kep nem olvashato (nem hallgat el)', async () => {
    rmSync(join(depot, 'Projektek', 'teszt', 'foto.png'))
    const html = (await callWorkbench(`/api/workbench/items/${itemId}/export.html`, 'GET')).raw.toString('utf-8')
    expect(html).toContain('A kép nem olvasható: foto.png')
  })

  it('EXPORT archivalt projektben is megy (olvasas)', async () => {
    setProjectArchived(pid, true)
    expect((await callWorkbench(`/api/workbench/items/${itemId}/export.html`, 'GET')).status).toBe(200)
  })

  it('KULDES: SEMMIT nem kuld -- egy fuggo email_send jegy szuletik a fo agensnek, a melleklet a store-ba kerul', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', {
      to: 'ugyfel@pelda.hu', subject: '', message: 'Szia, küldöm a posztot.', attachment: 'html',
    })
    expect(r.status).toBe(201)
    expect(r.body.status).toBe('pending')
    expect(r.body.message).toMatch(/jóváhagyásra vár/i)
    const pending = listPendingApprovals()
    expect(pending).toHaveLength(1)
    const a = pending[0]
    expect(a.id).toBe(r.body.approval_id)
    expect(a.category).toBe('email_send')
    expect(a.agent_id).toBe(MAIN_AGENT_ID)
    expect(a.status).toBe('pending')
    expect(a.action_description).toContain('ugyfel@pelda.hu')
    expect(a.action_description).toContain('Tárgy: Nyári <poszt>')
    const payload = JSON.parse(a.action_payload || '{}')
    expect(payload.source).toBe('workbench')
    expect(payload.project).toBe(pid)
    expect(payload.input.to).toBe('ugyfel@pelda.hu')
    // A melleklet a store alatti export-mappaba kerult, NEM a felhasznalo projektmappajaba.
    expect(payload.input.attachment_path.startsWith(exportsDir)).toBe(true)
    expect(readFileSync(payload.input.attachment_path, 'utf-8')).toContain('Első bekezdés')
    expect(readdirSync(join(depot, 'Projektek', 'teszt'))).toEqual(['foto.png'])
    // A fo agens ertesitest kapott a MEGLEVO csatornan.
    const note = getDb().prepare("SELECT content FROM agent_messages WHERE content LIKE '[APPROVAL_REQUEST]%'").get() as { content: string } | undefined
    expect(note?.content).toContain(`id=${r.body.approval_id}`)
    expect(note?.content).toContain('category=email_send')
  })

  it('KULDES az eredeti fajllal: a melleklet a forrasfajl maga', async () => {
    writeFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.pdf'), '%PDF-1.4')
    const d = createWorkItem({ project_id: pid, title: 'Ajánlat', type: 'document', source_path: 'Projektek/teszt/ajanlat.pdf' })
    if (!d.ok) throw new Error('d')
    const r = await callWorkbench(`/api/workbench/items/${d.item.id}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'source' })
    expect(r.status).toBe(201)
    expect(r.body.attachment).toEqual({ name: 'ajanlat.pdf', kind: 'source' })
    // Forras nelkuli munkadarabnal az "eredeti fajl" nem valaszthato -- emberi mondattal.
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'source' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('send_no_source')
  })

  it('rossz cim, tobb cimzett, archivalt projekt: nem szuletik jegy', async () => {
    for (const to of ['', 'nem-email', 'a@b.hu, c@d.hu']) {
      const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('send_bad_to')
    }
    setProjectArchived(pid, true)
    const arch = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' })
    expect(arch.status).toBe(409)
    expect(listPendingApprovals()).toHaveLength(0)
    expect(existsSync(exportsDir)).toBe(false)
  })
})

describe('a felulet', () => {
  const ITEM = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft', current_version_id: 'v1' }

  function setup(opts: { archived?: boolean; preview?: Record<string, unknown>; approvalStatus?: string } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács weboldal', archived: !!opts.archived }
    h.respond((url, init) => {
      if (url.includes('/send-request') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        if (body.to === 'rossz') return { status: 400, body: { error: 'send_bad_to', message: 'Adj meg egy érvényes email-címet.' } }
        return { status: 201, body: { ok: true, approval_id: 'ap1', status: 'pending', message: 'A küldés jóváhagyásra vár.' } }
      }
      if (url.includes('/api/approvals/ap1')) return { status: 200, body: { id: 'ap1', status: opts.approvalStatus || 'pending' } }
      if (url.includes('/preview')) return { status: 200, body: opts.preview || { available: true, kind: 'parts' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [{ id: 'x', kind: 'text', text: 'szöveg', position: 1 }], project } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  async function openExport(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="export-open"'))
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/preview'))).toBe(true))
    h.click({ 'data-wb-act': 'export-open' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-exp'))
  }

  it('egyetlen verzional is ott az Export gomb; a panel: PDF, PNG, HTML letoltes, kuldes jovahagyassal', async () => {
    const h = setup()
    await openExport(h)
    const html = h.html()
    expect(html).toContain('data-wb-act="export-print"')
    expect(html).toContain('data-wb-act="export-png"')
    expect(html).toMatch(/href="\/api\/workbench\/items\/w1\/export\.html\?lang=hu&download=1"/)
    expect(html).toContain('id="wbSendForm"')
    expect(html).toContain('workbench.exp.send_gate')
  })

  it('PDF: uj lapon a nyomtathato lap nyilik (print=1); letiltott felugronal kimondja a masik utat', async () => {
    const h = setup()
    await openExport(h)
    h.win.open = (u: string) => { h.opened.push(u); return {} }
    h.click({ 'data-wb-act': 'export-print' })
    expect(h.opened[0]).toContain('/api/workbench/items/w1/export.html?lang=hu&print=1')
    h.win.open = () => null
    h.click({ 'data-wb-act': 'export-print' })
    expect(h.toasts.join(' ')).toContain('workbench.exp.popup_blocked')
  })

  it('KULDES: a gomb CSAK jovahagyas-kerest nyit (send-request), email-vegpontot SOSE hiv; utana az allapot a forrasbol', async () => {
    const h = setup({ approvalStatus: 'approved' })
    await openExport(h)
    h.inputs.wbSendTo = { value: 'ugyfel@pelda.hu', focus() {} }
    h.inputs.wbSendSubject = { value: 'Poszt', focus() {} }
    h.inputs.wbSendMessage = { value: 'Szia!', focus() {} }
    h.inputs.wbSendAttach = { value: 'html', focus() {} }
    h.click({ 'data-wb-act': 'send-request' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.exp.send_status.pending'))
    const post = h.fetchCalls.find((c) => c.url.includes('/send-request'))!
    expect(JSON.parse(String(post.init!.body))).toEqual({ to: 'ugyfel@pelda.hu', subject: 'Poszt', message: 'Szia!', attachment: 'html', version: null })
    expect(h.fetchCalls.some((c) => c.url.includes('/api/email/'))).toBe(false)
    expect(h.toasts.join(' ')).toContain('A küldés jóváhagyásra vár.')
    h.click({ 'data-wb-act': 'send-refresh' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.exp.send_status.approved'))
    expect(h.fetchCalls.some((c) => c.url.includes('/api/approvals/ap1'))).toBe(true)
  })

  it('ures cimnel es szerver-hibanal a mondat a helyen marad, a beirt adat megmarad', async () => {
    const h = setup()
    await openExport(h)
    h.click({ 'data-wb-act': 'send-request' })
    expect(h.html()).toContain('workbench.exp.send_to_missing')
    expect(h.fetchCalls.some((c) => c.url.includes('/send-request'))).toBe(false)
    h.inputs.wbSendTo = { value: 'rossz', focus() {} }
    h.inputs.wbSendMessage = { value: 'megmarad', focus() {} }
    h.click({ 'data-wb-act': 'send-request' })
    await vi.waitFor(() => expect(h.html()).toContain('Adj meg egy érvényes email-címet.'))
    expect(h.html()).toContain('value="rossz"')
    expect(h.html()).toContain('>megmarad</textarea>')
  })

  it('PDF/irodai dokumentumbol nem kinal PNG-t, es megmondja, miert', async () => {
    const h = setup({ preview: { available: true, kind: 'pdf', url: '/api/life/file?rel=x.pdf', rel: 'P/x.pdf', name: 'x.pdf' } })
    await openExport(h)
    expect(h.html()).not.toContain('data-wb-act="export-png"')
    expect(h.html()).toContain('workbench.exp.png_none')
    expect(h.html()).toContain('workbench.exp.source')
  })

  it('ARCHIVALT projekt: exportalni lehet, kuldeni nem', async () => {
    const h = setup({ archived: true })
    await openExport(h)
    expect(h.html()).toContain('data-wb-act="export-print"')
    expect(h.html()).not.toContain('id="wbSendForm"')
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = setup()
    await openExport(h)
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'szöveg'])).toBe('')
  })
})
