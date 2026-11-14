// #916: the e-mail panel really reads the "Sending details" block of the context file (behaviour, not source text):
// recipient, subject and covering text come from the block; with no e-mail address the recipient stays empty; an empty block
// (placeholders) changes nothing; a context.rewrite keeps the filled block.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { ensureItemContext, readItemContext, readSendDetails, rewriteItemContext, setSendDetails } from '../workbench-item-context.js'
import { defaultMailBody, knownRecipient, mailSubject } from '../workbench-maildraft.js'
import { resolveLifePath } from '../life-explorer.js'

describe('#916 the e-mail panel reads the Sending details block', () => {
  let depot = ''
  let itemId = ''
  let projectId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-sendblock-'))
    for (const k of ['MARVEEN_DEPOT', 'OWNER_NAME']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['OWNER_NAME'] = 'Boss'
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    projectId = p.project.id
    if (!updateProject(projectId, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('projektmappa')
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: projectId, type: 'document', title: 'Widerspruch' })
    itemId = c.body.item.id as string
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(depot, { recursive: true, force: true })
  })

  const item = () => getWorkItem(itemId)!
  const project = () => getProject(projectId)!

  it('a new context file starts with an empty block, and the empty block gives no recipient / subject / body', () => {
    const r = ensureItemContext(item(), project())
    expect(r.rel).toBeTruthy()
    const text = readItemContext(item())!.text
    expect(text.indexOf('## Küldési adatok')).toBeGreaterThan(-1)
    expect(text.indexOf('## Küldési adatok')).toBeLessThan(text.indexOf('## Feladat'))
    expect(readSendDetails(item())).not.toBeNull()
    expect(knownRecipient(item())).toBe('')
    expect(mailSubject(item())).toBe('')
  })

  it('the recipient, subject and covering text written by context.send reach the panel', () => {
    const w = setSendDetails(item(), project(), {
      name: 'Amt', email: 'sozialamt@stadt-chemnitz.de', postal: 'Weg 1, 09111 Chemnitz',
      subject: 'Widerspruch Az. 12', body: 'Sehr geehrte Damen und Herren,\n\nanbei mein Widerspruch.', lang: 'de',
    })
    expect(w.ok).toBe(true)
    expect(knownRecipient(item())).toBe('sozialamt@stadt-chemnitz.de')
    expect(mailSubject(item())).toBe('Widerspruch Az. 12')
    expect(defaultMailBody(item(), 'de', 0)).toBe('Sehr geehrte Damen und Herren,\n\nanbei mein Widerspruch.')
  })

  it('no e-mail address: the recipient stays empty but the postal address and name are in the file', () => {
    setSendDetails(item(), project(), { name: 'Amtsgericht Chemnitz', postal: 'Dr.-Külz-Ring 1, 09111 Chemnitz' })
    expect(knownRecipient(item())).toBe('')
    const d = readSendDetails(item())!
    expect(d.name).toBe('Amtsgericht Chemnitz')
    expect(d.postal).toContain('09111')
  })

  it('context.rewrite keeps the filled block', () => {
    setSendDetails(item(), project(), { email: 'a@amt.de', subject: 'Betreff' })
    const rw = rewriteItemContext(item(), project(), '# Kontextus\n\n## Feladat\nrendezett\n')
    expect(rw.ok).toBe(true)
    expect(knownRecipient(item())).toBe('a@amt.de')
    expect(mailSubject(item())).toBe('Betreff')
    const abs = resolveLifePath(readItemContext(item())!.rel)!
    expect(readFileSync(abs, 'utf8')).toContain('rendezett')
  })
})
