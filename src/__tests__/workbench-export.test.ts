// #406, 6. pont -- EXPORT (PDF-nyomtathato lap, kep) es KULDES CSAK a
// jovahagyasi kapun at: a szerver es a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, listPendingApprovals, getDb } from '../db.js'
import { _setSendDeps } from '../workbench-export.js'
import type { SendingAccount } from '../mail-send.js'

// #797: what the shared sender got (the first attachment's path, as the old mailer's).
type Mail = { account: string; to: string; subject: string; body: string; attachmentPath: string }
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
  // A kuldo cserelve: valodi level SOHA nem megy ki a tesztbol.
  const AGENT = { kind: 'token' }
  let sent: Mail[] = []
  let mailerResult: { ok: true; messageId: string } | { ok: false; error: string } = { ok: true, messageId: 'gm-123' }
  let ready: string | null = null

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
    sent = []
    mailerResult = { ok: true, messageId: 'gm-123' }
    ready = null
    // #797: the shared sender's account list and send, replaced (no real mail). `ready` != null = no account at all.
    const ACCOUNTS: SendingAccount[] = [{ id: 'iroda', address: 'en@pelda.hu', kind: 'mailbox' }, { id: 'google', address: 'en@gmail.com', kind: 'google' }]
    _setSendDeps({
      accounts: () => (ready ? [] : ACCOUNTS),
      send: async (account, m) => {
        sent.push({ account, to: m.to, subject: m.subject, body: m.body, attachmentPath: (m.attachments || [])[0] || '' })
        const acc = ACCOUNTS.find((a) => a.id === account)!
        return mailerResult.ok ? { ok: true, account, kind: acc.kind, address: acc.address, messageId: mailerResult.messageId } : { ok: false, code: 'send_failed', detail: mailerResult.error }
      },
    })
    writeFileSync(join(depot, 'Projektek', 'teszt', 'foto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    addWorkItemPart({ work_item_id: itemId, kind: 'text', text: 'Első bekezdés <b>nem html</b>\n\nMásodik' })
    addWorkItemPart({ work_item_id: itemId, kind: 'image', asset_path: 'Projektek/teszt/foto.png', caption: 'A fotó' })
  })

  afterEach(() => {
    _setSendDeps()
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

  it('KULDES ugynoktol (token): SEMMIT nem kuld -- egy fuggo email_send jegy szuletik a fo agensnek, a melleklet a store-ba kerul', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', {
      to: 'ugyfel@pelda.hu', subject: '', message: 'Szia, küldöm a posztot.', attachment: 'html',
    }, undefined, AGENT)
    expect(sent).toHaveLength(0)
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
    const r = await callWorkbench(`/api/workbench/items/${d.item.id}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'source' }, undefined, AGENT)
    expect(r.status).toBe(201)
    expect(r.body.attachment).toEqual({ name: 'ajanlat.pdf', kind: 'source' })
    // Forras nelkuli munkadarabnal az "eredeti fajl" nem valaszthato -- emberi mondattal.
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'source' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('send_no_source')
  })

  it('KULDES a tulajdonostol (session): AZONNAL kimegy, jegy NELKUL, a valaszban a kuldo azonositoja', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', {
      to: 'ugyfel@pelda.hu', subject: 'Poszt', message: 'Szia, küldöm.', attachment: 'html',
    })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ ok: true, status: 'sent', message_id: 'gm-123' })
    expect(r.body.message).toMatch(/Elküldve/)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'ugyfel@pelda.hu', subject: 'Poszt', body: 'Szia, küldöm.' })
    expect(readFileSync(sent[0].attachmentPath, 'utf-8')).toContain('Első bekezdés')
    expect(listPendingApprovals()).toHaveLength(0)
    const note = getDb().prepare("SELECT content FROM agent_messages WHERE content LIKE '[APPROVAL_REQUEST]%'").get()
    expect(note).toBeUndefined()
  })

  it('KULDES a tulajdonostol: ures uzenetnel semleges kiserosor, nem alairas', async () => {
    await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'html' })
    expect(sent[0].body).toMatch(/^Csatolva: /)
    await callWorkbench(`/api/workbench/items/${itemId}/send-request?lang=en`, 'POST', { to: 'a@b.hu', attachment: 'html' }, { 'accept-language': 'en' })
    expect(sent).toHaveLength(2)
    expect(sent[1].body).toMatch(/^Attached: /)
  })

  it('KULDES a tulajdonostol, kuldo hiba: a TENYLEGES hiba jon vissza, nem "elkuldve", es jegy sem szuletik', async () => {
    mailerResult = { ok: false, error: 'HIBA 403: insufficient scope' }
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' })
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('send_failed')
    expect(r.body.detail).toBe('HIBA 403: insufficient scope')
    expect(r.body.message).toMatch(/NEM ment ki/)
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('KULDES a tulajdonostol, friss telepites (nincs bekotott fiok): emberi mondat, semmi nem megy ki, mellekletet sem ir', async () => {
    ready = 'no_account'
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('send_no_mail_account')
    expect(r.body.message).toMatch(/Email beállítások/)
    expect(r.body.message).toMatch(/Fiókok/)
    expect(sent).toHaveLength(0)
    expect(existsSync(exportsDir)).toBe(false)
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('KULDES federacios tarstol vagy eszkozkulccsal: jovahagyasra megy, nem azonnal', async () => {
    for (const auth of [{ kind: 'federation', peer: 'tars' }, { kind: 'device', device: 'telefon', deviceId: 1 }]) {
      const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' }, undefined, auth)
      expect(r.status).toBe(201)
      expect(r.body.status).toBe('pending')
    }
    expect(sent).toHaveLength(0)
    expect(listPendingApprovals()).toHaveLength(2)
  })

  // #797: the shared sender -- the account is chosen from the same list as the mail draft's, and the sending is logged.
  it('#797 KULDES a kivalasztott fiokrol; ismeretlen fiokrol semmi nem megy ki', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'html', from_account: 'google' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ status: 'sent', from: 'en@gmail.com', sent_logged: 'marked' })
    expect(sent.map((m) => m.account)).toEqual(['google'])
    // no account asked: the first of the list
    await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'html' })
    expect(sent.map((m) => m.account)).toEqual(['google', 'iroda'])
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'html', from_account: 'regi' })
    expect(bad.status).toBe(409)
    expect(bad.body.error).toBe('send_bad_account')
    expect(bad.body.message).toMatch(/nincs bekötve/)
    expect(sent).toHaveLength(2)
  })

  it('#797 KULDES: a sikeres kuldes a munkadarabon latszik (Elkuldve), a sikertelen nem', async () => {
    const { sentStatus } = await import('../workbench-docsent.js')
    mailerResult = { ok: false, error: 'SMTP 535' }
    await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' })
    expect(sentStatus(itemId).sent).toBe(false)
    mailerResult = { ok: true, messageId: 'm-1' }
    await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' })
    expect(sentStatus(itemId)).toMatchObject({ sent: true, how: 'manual' })
  })

  it('#797 JOVAHAGYOTT KULDES: a rendszer kuldi el a kert fiokrol, pontosan egyszer; elutasitva semmi', async () => {
    const { settleSendApprovals, sendApprovalOutcome } = await import('../workbench-export.js')
    const { resolveApproval } = await import('../db.js')
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'ugyfel@pelda.hu', subject: 'Poszt', attachment: 'html', from_account: 'iroda' }, undefined, AGENT)
    expect(r.status).toBe(201)
    const a = listPendingApprovals()[0]
    const payload = JSON.parse(a.action_payload || '{}')
    expect(payload).toMatchObject({ server_sends: true, from_account: 'iroda' })
    expect(a.action_description).toContain('Feladó: en@pelda.hu')
    expect(a.action_description).toContain('a rendszer maga küldi el')
    // still pending: nothing goes out
    expect(await settleSendApprovals()).toBe(0)
    expect(sent).toHaveLength(0)
    resolveApproval(a.id, 'approved', 'owner')
    expect(await settleSendApprovals()).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ account: 'iroda', to: 'ugyfel@pelda.hu', subject: 'Poszt' })
    expect(readFileSync(sent[0].attachmentPath, 'utf-8')).toContain('Első bekezdés')
    expect(sendApprovalOutcome(a.id)).toEqual({ outcome: 'sent', detail: 'gm-123' })
    const st = await callWorkbench(`/api/workbench/items/${itemId}/send-request/${a.id}`, 'GET')
    expect(st.body).toMatchObject({ outcome: 'sent' })
    // a second decision event does not send it again
    expect(await settleSendApprovals()).toBe(0)
    expect(sent).toHaveLength(1)
    // rejected: nothing
    const r2 = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'x@y.hu', attachment: 'html' }, undefined, AGENT)
    resolveApproval(r2.body.approval_id, 'rejected', 'owner')
    expect(await settleSendApprovals()).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it('#797 JOVAHAGYOTT KULDES: egy regi jegyet (server_sends nelkul) nem kuld el a rendszer -- azt a fo agens viszi, mint eddig', async () => {
    const { settleSendApprovals } = await import('../workbench-export.js')
    const { resolveApproval } = await import('../db.js')
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu', attachment: 'html' }, undefined, AGENT)
    const a = listPendingApprovals()[0]
    const p = JSON.parse(a.action_payload || '{}')
    delete p.server_sends
    getDb().prepare('UPDATE approvals SET action_payload = ? WHERE id = ?').run(JSON.stringify(p), r.body.approval_id)
    resolveApproval(a.id, 'approved', 'owner')
    expect(await settleSendApprovals()).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('#797 jovahagyasra kert kuldes fiok nelkul: emberi mondat, jegy nem szuletik', async () => {
    ready = 'no_account'
    const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to: 'a@b.hu' }, undefined, AGENT)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('send_no_mail_account')
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('rossz cim, tobb cimzett, archivalt projekt: nem szuletik jegy', async () => {
    for (const to of ['', 'nem-email', 'a@b.hu, c@d.hu']) {
      const r = await callWorkbench(`/api/workbench/items/${itemId}/send-request`, 'POST', { to })
      expect(r.status).toBe(400)
      expect(sent).toHaveLength(0)
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
        if (body.to === 'most@pelda.hu') return { status: 201, body: { ok: true, status: 'sent', message_id: 'gm-9', message: 'Elküldve.' } }
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

  it('KULDES azonnal (tulajdonos): "elkuldve" a kuldo azonositojaval, jovahagyas-lekerdezes nincs', async () => {
    const h = setup()
    await openExport(h)
    h.inputs.wbSendTo = { value: 'most@pelda.hu', focus() {} }
    h.click({ 'data-wb-act': 'send-request' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.exp.send_status.sent'))
    expect(h.html()).not.toContain('data-wb-act="send-refresh"')
    expect(h.toasts.join(' ')).toContain('Elküldve.')
    expect(h.fetchCalls.some((c) => c.url.includes('/api/approvals/'))).toBe(false)
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
