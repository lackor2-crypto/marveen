// Boss, 2026-11-08: the DRV Clearingstelle letter got the Minijob-Zentrale's address. The recipient is the one of the letter head.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { sweepItemContexts, appendItemContext } from '../workbench-item-context.js'
import { addSection, addBlock } from '../workbench-docmodel.js'
import { knownRecipient, letterNeedsRecipientEmail } from '../workbench-maildraft.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

let dir = ''
let itemId = ''
let pid = ''
beforeEach(async () => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'wb-rcp-'))
  process.env['MARVEEN_DEPOT'] = dir
  const p = createProject({ name: 'Nemet' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  if (!updateProject(pid, { folder_path: 'Projektek/Nemet' }).ok) throw new Error('projektmappa')
  mkdirSync(join(dir, 'Projektek', 'Nemet'), { recursive: true })
  const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: pid, type: 'document', title: 'Level a DRV-nek' })
  itemId = c.body.item.id as string
  await sweepItemContexts()
  const s = addSection(itemId, 'Level')
  if (!s.ok) throw new Error('fejezet')
  addBlock(itemId, s.section.id, { text: 'Címzett:\nDeutsche Rentenversicherung Bund\nClearingstelle\n10704 Berlin', author: 'agent' })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT'] })

describe('the recipient of the mail comes from the letter head', () => {
  it('another authority\'s address in the context file is NOT taken, even when its line names the Clearingstelle', () => {
    appendItemContext(getWorkItem(itemId)!, getProject(pid)!, 'info', '- Ez a levél a Minijob-Zentrale (minijob@minijob-zentrale.de) és a DRV Bund Clearingstelle párja. A DRV címe még nem ismert.')
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('')
    expect(letterNeedsRecipientEmail(getWorkItem(itemId)!)).toBe(true)
  })
  it('a context line that names THIS recipient gives its address', () => {
    appendItemContext(getWorkItem(itemId)!, getProject(pid)!, 'info', '- Címzett e-mail (Deutsche Rentenversicherung Bund Clearingstelle): clearingstelle@example-drv.test, forrás: https://example.test')
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('clearingstelle@example-drv.test')
  })
})
