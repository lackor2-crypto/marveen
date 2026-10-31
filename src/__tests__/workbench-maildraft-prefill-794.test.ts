// #794 (Boss TG 4081, 2026-10-31): the mail form of a finalized letter opened with an empty recipient, an empty subject and the
// closing name "Boss" (the dashboard owner's nickname) although the letter itself knew all three. These tests pin the three facts:
// the subject is read from a "Betreff:" line inside a multi-line paragraph, the closing name is the letter's own signatory, and a
// stored row with empty fields still shows what is known (an untouched old default is shown as today's default).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), currentOwnerName: () => 'Boss' }))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { defaultMailBody, knownRecipient, mailDraftView, mailSubject } from '../workbench-maildraft.js'
import { letterSignatory } from '../workbench-letterinfo.js'
import { addAgentMessage, createAgentSession } from '../workbench-agent/sessions.js'

describe('#794 mail form prefill from the letter itself', () => {
  let depot = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-mailprefill-'))
    for (const k of ['MARVEEN_DEPOT', 'OWNER_NAME']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['OWNER_NAME'] = 'Boss'
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Sozialamt Widerspruch', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const s = addSection(itemId, 'Erklärung', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Stadt Chemnitz\nSozialamt\n09111 Chemnitz', author: 'owner' })
    addBlock(itemId, s.section.id, { text: 'Ihr Zeichen: 503409.609503\nSachbearbeiterin: Frau Jäckle\nBetreff: Mein Widerspruch vom 12. August 2026', author: 'owner' })
    addBlock(itemId, s.section.id, { text: 'Sehr geehrte Frau Jäckle!', author: 'owner' })
    addBlock(itemId, s.section.id, { text: '​', author: 'owner' })
    addBlock(itemId, s.section.id, { text: 'Bakos Éva\nErich-Steinfurth-Straße 25\n09131 Chemnitz', author: 'owner' })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(depot, { recursive: true, force: true })
  })

  it('the subject comes from a Betreff line inside a multi-line paragraph', () => {
    expect(mailSubject(getWorkItem(itemId)!)).toBe('Mein Widerspruch vom 12. August 2026')
  })

  it('the closing name is the letter\'s own signatory, never the owner nickname', () => {
    expect(letterSignatory(itemId)).toBe('Bakos Éva')
    const body = defaultMailBody(getWorkItem(itemId)!, 'de', 1)
    expect(body).toContain('Mit freundlichen Grüßen\nBakos Éva')
    expect(body).not.toContain('Boss')
    for (const l of ['hu', 'en'] as const) expect(defaultMailBody(getWorkItem(itemId)!, l, 0)).not.toContain('Boss')
  })

  it('a letter without a signatory closes without a name (no placeholder, no owner nickname)', () => {
    const w = createWorkItem({ project_id: (getDb().prepare('SELECT project_id FROM work_items WHERE id = ?').get(itemId) as { project_id: string }).project_id, title: 'Rovid', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    const s = addSection(w.item.id, 'A', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(w.item.id, s.section.id, { text: 'Hiermit widerspreche ich dem Bescheid vom 3. Mai 2026 vollumfaenglich.', author: 'owner' })
    expect(letterSignatory(w.item.id)).toBe('')
    expect(defaultMailBody(getWorkItem(w.item.id)!, 'de', 0)).not.toContain('Boss')
  })

  it('a stored row with empty recipient / subject and the old "Boss" default shows what is known today', () => {
    const item = getWorkItem(itemId)!
    expect(mailDraftView(item)).toBeNull() // creates the table
    const sess = createAgentSession({ project_id: item.project_id, work_item_id: itemId })
    addAgentMessage(sess.id, 'user', 'A levelet kuldd a sarah.jaeckle@stadt-chemnitz.de cimre')
    // the body an earlier version stored: no subject found, the owner nickname as the closing name
    const old = 'Sehr geehrte Damen und Herren,\n\nanbei übersende ich Ihnen das Schreiben mit 1 Anlage als PDF-Dateien im Anhang.\n\nMit freundlichen Grüßen\nBoss'
    getDb().prepare("INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at) VALUES (?, 'lackor2', 'a@b.de', '', '', 'x', '', '', '', ?, '[]', 1)").run(itemId, old)
    const v = mailDraftView(item)!
    expect(v.to).toBe('sarah.jaeckle@stadt-chemnitz.de')
    expect(v.subject).toBe('Mein Widerspruch vom 12. August 2026')
    expect(v.body).not.toContain('Boss')
    expect(v.body).toContain('Bakos Éva')
  })

  it('what the owner typed into the body or the recipient is never replaced', () => {
    const item = getWorkItem(itemId)!
    expect(mailDraftView(item)).toBeNull()
    getDb().prepare("INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at) VALUES (?, 'lackor2', 'a@b.de', '', '', 'x', 'x@y.de', '', 'Sajat targy', 'Sajat szoveg\n\nBoss', '[]', 1)").run(itemId)
    const v = mailDraftView(item)!
    expect(v).toMatchObject({ to: 'x@y.de', subject: 'Sajat targy', body: 'Sajat szoveg\n\nBoss' })
  })

  it('no address anywhere: the recipient stays empty (nothing is made up)', () => {
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('')
  })

  it('an address the letter itself carries is taken', () => {
    const s = addSection(itemId, 'Anhang', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'E-Mail: sozialamt@stadt-chemnitz.de', author: 'owner' })
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('sozialamt@stadt-chemnitz.de')
  })
})
