// #871 (Boss TG 5283): the e-mail draft of a finalized German letter had the owner's OWN address as recipient, and its body showed
// the closing twice with no signer name. Pins: (1) no address of a mail account set up in Marvin is ever a recipient / copy,
// the recipient the owner wrote in the chat or the context wins; (2) the name under the closing is the letter's signer, and a
// closing phrase is never taken for a name.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), currentOwnerName: () => 'Boss' }))
vi.mock('../mail-send.js', async (orig) => ({
  ...(await orig<typeof import('../mail-send.js')>()),
  sendingAccounts: () => [
    { id: 'a', address: 'lackor3@example.com', kind: 'mailbox' },
    { id: 'google', address: 'Boss.Own@gmail.com', kind: 'google' },
  ],
}))
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { defaultMailBody, firstForeignAddress, isOwnAddress, knownRecipient, saveMailDraft, withoutOwnAddresses } from '../workbench-maildraft.js'
import { letterSignatory } from '../workbench-letterinfo.js'
import { addAgentMessage, createAgentSession } from '../workbench-agent/sessions.js'

describe('#871 own addresses are never recipients', () => {
  let depot = ''
  let itemId = ''
  let projectId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-ownaddr-'))
    for (const k of ['MARVEEN_DEPOT', 'OWNER_NAME']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['OWNER_NAME'] = 'Boss'
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    projectId = p.project.id
    const w = createWorkItem({ project_id: projectId, title: 'Widerspruch', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(depot, { recursive: true, force: true })
  })

  const block = (text: string, id = itemId, kind?: string): void => {
    const s = addSection(id, 'A' + Math.random(), { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(id, s.section.id, { text, author: 'owner', ...(kind ? { kind } : {}) } as never)
  }

  it('helpers: the own address is recognised case-insensitively and skipped', () => {
    expect(isOwnAddress('LACKOR3@example.com')).toBe(true)
    expect(firstForeignAddress('Absender lackor3@example.com, an amt@stadt.de')).toBe('amt@stadt.de')
    expect(firstForeignAddress('nur lackor3@example.com')).toBe('')
    expect(withoutOwnAddresses('boss.own@gmail.com, amt@stadt.de')).toBe('amt@stadt.de')
  })

  it('the letter lists the own address first: the foreign one is the recipient', () => {
    block('Absender: Bakos Éva, lackor3@example.com\nAn: sozialamt@stadt-chemnitz.de')
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('sozialamt@stadt-chemnitz.de')
  })

  it('only the own address known: the recipient stays empty (never the own one)', () => {
    block('E-Mail: lackor3@example.com')
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('')
  })

  it('the address the owner wrote in the chat wins over a letter that names the own address', () => {
    block('Absender lackor3@example.com')
    const sess = createAgentSession({ project_id: projectId, work_item_id: itemId })
    addAgentMessage(sess.id, 'user', 'Kuldd a lackor3@example.com es a sarah@stadt-chemnitz.de cimre')
    expect(knownRecipient(getWorkItem(itemId)!)).toBe('sarah@stadt-chemnitz.de')
  })

  it('saving a draft with an own address as To or Cc is refused', async () => {
    block('Hiermit widerspreche ich.')
    const item = getWorkItem(itemId)!
    for (const input of [{ to: 'lackor3@example.com' }, { to: 'amt@stadt.de', cc: 'boss.own@gmail.com' }]) {
      const r = await saveMailDraft(item, input as never, 'owner')
      expect(r).toMatchObject({ ok: false, code: 'own_address' })
    }
  })
})

describe('#871 the name under the closing is the signer', () => {
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    process.env['OWNER_NAME'] = 'Boss'
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Brief', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  const add = (text: string, kind?: string): void => {
    const s = addSection(itemId, 'S' + Math.random(), { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text, author: 'owner', ...(kind ? { kind } : {}) } as never)
  }

  it('a closing line as the last block is not a name; the Absender block gives the signer', () => {
    add('Absender:\nBakos Éva\nErich-Steinfurth-Straße 25\n09131 Chemnitz')
    add('Sehr geehrte Damen und Herren,')
    add('Mit freundlichen Grüßen')
    expect(letterSignatory(itemId)).toBe('Bakos Éva')
  })

  it('closing then name in one paragraph gives the name', () => {
    add('Hiermit widerspreche ich.')
    add('Mit freundlichen Grüßen\nBakos Éva')
    expect(letterSignatory(itemId)).toBe('Bakos Éva')
  })

  it('the default body has the closing once and the signer name', () => {
    add('Absender:\nBakos Éva\nErich-Steinfurth-Straße 25\n09131 Chemnitz')
    add('Hiermit widerspreche ich.')
    add('Mit freundlichen Grüßen')
    const body = defaultMailBody(getWorkItem(itemId)!, 'de', 1)
    expect(body.match(/Mit freundlichen Grüßen/g)).toHaveLength(1)
    expect(body).toContain('Mit freundlichen Grüßen\nBakos Éva')
  })
})
