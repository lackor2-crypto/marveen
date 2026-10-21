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
const { sentStatus } = await import('../workbench-docsent.js')
const { detectSentByMail, normName, registerSentMailPort } = await import('../workbench-sent-detect.js')

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
})
