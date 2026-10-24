// #741 (Boss TG 4131/4135): a document counts as sent when the Sent mailbox of the sender holds its PDF as an attachment;
// a changed subject must not matter.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-sentdet-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-sentdet-store-'))
process.env.MARVEEN_DEPOT = depot
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase, getDb } = await import('../db.js')
const { createProject } = await import('../projects.js')
const { createWorkItem } = await import('../workbench.js')
const { sentStatus, listSent } = await import('../workbench-docsent.js')
const { detectSentByMail, finalsCarriedBy, normName, registerSentMailPort } = await import('../workbench-sent-detect.js')

function item(title: string, pdf: string) {
  const p = createProject({ name: 'P ' + title })
  if (!p.ok) throw new Error('project')
  const w = createWorkItem({ project_id: p.project.id, title, type: 'document' } as any)
  if (!w.ok) throw new Error('item')
  getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
    .run('v-' + w.item.id, w.item.id, 10, Math.floor(Date.now() / 1000) - 60, JSON.stringify({ final: true, label: 'Végleges', content_hash: 'h', pdf_path: 'x/' + pdf, pdf_name: pdf }))
  return w.item.id
}

describe('sent detection from the Sent mailbox', () => {
  it('normName ignores case, spaces and a copy mark', () => {
    expect(normName('Antrag  (2) - végleges.PDF')).toBe(normName('antrag - végleges.pdf'))
  })

  it('marks a document sent when an attachment name matches, whatever the subject is', async () => {
    initDatabase(':memory:')
    const a = item('Antrag', 'Antrag - végleges.pdf')
    const b = item('Other', 'Other - végleges.pdf')
    registerSentMailPort({
      accounts: () => ['acc'],
      recent: async () => [{ id: '1', date: new Date().toISOString(), to: 'amt@example.de', messageId: '<m1>', attachments: ['Antrag - végleges (2).pdf'] }],
    })
    const found = await detectSentByMail([a, b])
    expect(found).toEqual([a])
    expect(sentStatus(a).sent).toBe(true)
    expect(sentStatus(b).sent).toBe(false)
  })

  it('leaves the document unsent when the mailbox cannot be read', async () => {
    initDatabase(':memory:')
    const a = item('Antrag', 'Antrag - végleges.pdf')
    registerSentMailPort({ accounts: () => ['acc'], recent: async () => { throw new Error('imap down') } })
    expect(await detectSentByMail([a])).toEqual([])
    expect(sentStatus(a).sent).toBe(false)
  })

  // #750: the sending is recorded on the final whose file the mail really carried, not on the newest final.
  function twoFinals(title: string) {
    const p = createProject({ name: 'P ' + title })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title, type: 'document' } as any)
    if (!w.ok) throw new Error('item')
    const now = Math.floor(Date.now() / 1000)
    const add = (no: number, age: number, pdf: string) => getDb().prepare('INSERT INTO work_item_versions (id, work_item_id, version_no, created_at, metadata_json) VALUES (?, ?, ?, ?, ?)')
      .run(`v${no}-${w.item.id}`, w.item.id, no, now - age, JSON.stringify({ final: true, label: 'Végleges ' + no, content_hash: 'h' + no, pdf_path: 'x/' + pdf, pdf_name: pdf }))
    add(10, 3600, `${title} - v1.pdf`)
    add(11, 60, `${title} - v2.pdf`)
    return { id: w.item.id, v1: `v10-${w.item.id}`, v2: `v11-${w.item.id}` }
  }
  const mail = (id: string, attachments: string[], ageSec = 0) => ({ id, date: new Date(Date.now() - ageSec * 1000).toISOString(), to: 'amt@example.de', messageId: '<' + id + '>', attachments })

  it('records the OLDER final when that is the one the mail carried (not the newest final)', async () => {
    initDatabase(':memory:')
    const d = twoFinals('Antrag')
    registerSentMailPort({ accounts: () => ['acc'], recent: async () => [mail('1', ['Antrag - v1.pdf'])] })
    expect(await detectSentByMail([d.id])).toEqual([d.id])
    expect(listSent(d.id).map((s) => s.version_id)).toEqual([d.v1])
  })

  it('records every final that was sent, each on its own version', async () => {
    initDatabase(':memory:')
    const d = twoFinals('Antrag')
    registerSentMailPort({ accounts: () => ['acc'], recent: async () => [mail('2', ['Antrag - v2.pdf'], 10), mail('1', ['Antrag - v1.pdf'], 30)] })
    await detectSentByMail([d.id])
    expect(listSent(d.id).map((s) => s.version_id).sort()).toEqual([d.v1, d.v2].sort())
  })

  it('a mail that carries only a name of the stored mail draft (no final) is marked by hand, on no version', async () => {
    initDatabase(':memory:')
    const d = twoFinals('Antrag')
    getDb().exec("CREATE TABLE IF NOT EXISTS wb_doc_maildraft (work_item_id TEXT PRIMARY KEY, from_account TEXT, from_addr TEXT, file_name TEXT, sha TEXT, package_key TEXT, to_addr TEXT, cc_addr TEXT, subject TEXT, body TEXT, attachments_json TEXT, updated_at INTEGER)")
    getDb().prepare("INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at) VALUES (?, 'acc', '', '', '', '', '', '', '', '', ?, 0)")
      .run(d.id, JSON.stringify([{ name: 'Melleklet.pdf' }]))
    registerSentMailPort({ accounts: () => ['acc'], recent: async () => [mail('3', ['Melleklet.pdf'])] })
    expect(await detectSentByMail([d.id])).toEqual([d.id])
    expect(listSent(d.id)).toEqual([])
    expect(sentStatus(d.id)).toMatchObject({ sent: true, how: 'manual' })
  })

  it('two finals with a file of the same name: the newest one that already existed when the mail went out', () => {
    const f = (v: string, created_at: number) => ({ version_id: v, created_at, names: new Set([normName('Antrag - végleges.pdf')]) })
    const finals = [f('old', 1_000_000), f('mid', 2_000_000), f('new', 9_000_000)]
    expect(finalsCarriedBy(finals, ['Antrag - végleges.pdf'], new Date(3_000_000 * 1000).toISOString())).toEqual(['mid'])
    // sent before every final existed (clock skew beyond a day): the oldest, never a later one
    expect(finalsCarriedBy(finals, ['Antrag - végleges.pdf'], new Date(0).toISOString())).toEqual(['old'])
  })

  it('a final made hours AFTER the mail is not picked for a file name both finals made', () => {
    const t0 = 1_000_000
    const f = (v: string, created_at: number, ...n: string[]) => ({ version_id: v, created_at, names: new Set(n.map(normName)) })
    const finals = [f('v1', t0, 'Antrag.pdf'), f('v2', t0 + 10 * 3600, 'Antrag.pdf')]
    expect(finalsCarriedBy(finals, ['Antrag.pdf'], new Date((t0 + 5 * 3600) * 1000).toISOString())).toEqual(['v1'])
  })

  it('an annex every final made does not drag the newer final in when the main file names the older one', () => {
    const f = (v: string, created_at: number, ...n: string[]) => ({ version_id: v, created_at, names: new Set(n.map(normName)) })
    const finals = [f('v1', 1_000_000, 'Antrag v1.pdf', 'Anlage 1.pdf'), f('v2', 2_000_000, 'Antrag v2.pdf', 'Anlage 1.pdf')]
    const sentLater = new Date(3_000_000 * 1000).toISOString()
    expect(finalsCarriedBy(finals, ['Antrag v1.pdf', 'Anlage 1.pdf'], sentLater)).toEqual(['v1'])
    expect(finalsCarriedBy(finals, ['Antrag v2.pdf', 'Anlage 1.pdf'], sentLater)).toEqual(['v2'])
  })
})
