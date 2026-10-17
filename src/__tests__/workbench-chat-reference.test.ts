// Boss, 2026-10-16: a file attached in the chat ONLY for the agent ("this is what I mean, fix it like this") must not
// land in the Uploads folder or among the materials: it goes to the work item's "Agent" folder, unregistered.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { attachChatReference, listWorkItemAssetsSynced } from '../workbench-assets.js'
import { lifeMoveCandidates } from '../workbench-life-move.js'

describe('chat-hivatkozas: csak az agentnek (nem anyag)', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-chatref-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda fejlesztese' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    const up = updateProject(pid, { folder_path: 'Projektek/Iroda' })
    if (!up.ok) throw new Error('projektmappa')
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function newItem() {
    const w = createWorkItem({ project_id: pid, title: 'Ajanlat', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    return w.item
  }

  it('az "Agent" mappaba kerul, nem a Feltoltesekbe, es nincs az anyagok kozott', () => {
    const item = newItem()
    const r = attachChatReference(item, 'Screenshot (2538).png', Buffer.from('PNG'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rel).toContain('/Agent/')
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Ajanlat', 'Agent', 'Screenshot (2538).png'))).toBe(true)
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Ajanlat', 'Feltöltések', 'Screenshot (2538).png'))).toBe(false)
    expect(listWorkItemAssetsSynced(item.id).map((a) => a.name)).not.toContain('Screenshot (2538).png')
  })

  it('ugyanaz a nev masodszor nem ir felul semmit, az angol nevu mappa is felismert', () => {
    const item = newItem()
    const a = attachChatReference(item, 'minta.png', Buffer.from('1'))
    const b = attachChatReference(item, 'minta.png', Buffer.from('2'), { lang: 'en' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.renamed).toBe(true)
    expect(b.rel.split('/').slice(0, -1)).toEqual(a.rel.split('/').slice(0, -1))
    expect(readFileSync(join(projDir(), 'Munkadarabok', 'Ajanlat', 'Agent', 'minta.png'), 'utf8')).toBe('1')
  })

  it('Boss TG 3481: the very same file (name + bytes) attached again is the one already there, not a "name (2)" twin', () => {
    const item = newItem()
    const a = attachChatReference(item, 'minta.png', Buffer.from('1'))
    const again = attachChatReference(item, 'minta.png', Buffer.from('1'))
    expect(a.ok && again.ok).toBe(true)
    if (!a.ok || !again.ok) return
    expect(again.renamed).toBe(false)
    expect(again.rel).toBe(a.rel)
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Ajanlat', 'Agent', 'minta (2).png'))).toBe(false)
  })

  it('az "Agent" mappa nem jelolt a Life-fara athelyezesre', () => {
    const item = newItem()
    attachChatReference(item, 'minta.png', Buffer.from('1'))
    const c = lifeMoveCandidates(getProject(pid)!, getWorkItem(item.id)!)
    if (c.ok) expect(c.files.map((f) => f.folder)).not.toContain('Agent')
  })
})
