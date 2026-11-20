// #890 (Boss TG 5767): an e-mail submission leaves a small text proof in the work item's own "Feladási bizonylatok" folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
vi.mock('../workbench-assets.js', async (orig) => ({ ...(await orig<typeof import('../workbench-assets.js')>()), workItemFolder: (id: string) => (id === 'noFolder' ? null : 'Munkadarabok/Level') }))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { buildEmailProofText, emailProofFileName, writeEmailProof } from '../workbench-email-proof.js'
import { addressesIn, pickSentMail } from '../workbench-sent-detect.js'

describe('e-mail proof of submission', () => {
  let depot = ''
  let saved: string | undefined
  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'mail-proof-'))
    saved = process.env.MARVEEN_DEPOT
    process.env.MARVEEN_DEPOT = depot
    initDatabase(':memory:')
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })

  const info = { date: '2026-11-09', time: '14:02', to: 'poststelle@sg.example.de', from: 'me@example.com', subject: 'Stellungnahme', attachments: ['a.pdf', 'b.pdf'], messageId: '<m1@x>' }

  it('the text carries who, to whom, subject, attachments, time and Message-ID', () => {
    const t = buildEmailProofText({ ...info, title: 'LSG levél' })
    for (const s of ['poststelle@sg.example.de', 'me@example.com', 'Stellungnahme', 'a.pdf; b.pdf', '2026-11-09 14:02', '<m1@x>', 'LSG levél']) expect(t).toContain(s)
    expect(buildEmailProofText({ date: '2026-11-09', to: 'x@y.z', byHand: true })).toContain('kézzel')
  })

  it('file name has the date, time and recipient and no path characters', () => {
    const n = emailProofFileName({ ...info, to: 'a/b:c@x.de' })
    expect(n).toBe('2026-11-09 14-02 E-mail feladás - a b c@x.de.txt')
  })

  it('writes into the work item\'s own proof folder, once per mail', () => {
    mkdirSync(join(depot, 'Projektek', 'P', 'Munkadarabok', 'Level'), { recursive: true })
    const c = createProject({ name: 'P', folder_path: 'Projektek/P' })
    if (!c.ok) throw new Error('create failed')
    const item = { id: 'it1', project_id: c.project.id, title: 'Level' } as never
    expect(writeEmailProof(item, info)).toBe(true)
    const dir = join(depot, 'Projektek', 'P', 'Munkadarabok', 'Level', 'Feladási bizonylatok')
    expect(readdirSync(dir).length).toBe(1)
    expect(readFileSync(join(dir, readdirSync(dir)[0]), 'utf8')).toContain('<m1@x>')
    expect(writeEmailProof(item, info)).toBe(false) // same Message-ID: not written twice
    expect(readdirSync(dir).length).toBe(1)
    expect(writeEmailProof(item, { ...info, messageId: '<m2@x>' })).toBe(true)
    expect(readdirSync(dir).length).toBe(2)
    expect(existsSync(join(depot, 'Projektek', 'P', 'Feladási bizonylatok'))).toBe(false)
  })

  it('an item without a folder of its own writes nothing and does not throw', () => {
    mkdirSync(join(depot, 'Projektek', 'Q'), { recursive: true })
    const c = createProject({ name: 'Q', folder_path: 'Projektek/Q' })
    if (!c.ok) throw new Error('create failed')
    expect(writeEmailProof({ id: 'noFolder', project_id: c.project.id, title: 'x' } as never, info)).toBe(false)
  })

  it('wiring: recordSent writes it for email, and the Sent-mailbox port passes from and subject', () => {
    const root = join(__dirname, '..', '..')
    const docsent = readFileSync(join(root, 'src', 'workbench-docsent.ts'), 'utf8')
    expect(docsent).toContain("if (method === 'email') writeEmailProof(")
    expect(readFileSync(join(root, 'src', 'web', 'routes', 'email.ts'), 'utf8')).toContain('subject: String(e.subject')
    expect(readFileSync(join(root, 'src', 'workbench-sent-detect.ts'), 'utf8')).toContain('mail: { from: hit.info.from')
  })

  it('wiring: the owner\'s hand mark (sent-mark route, e-mail) writes the proof too, in markSentManually', () => {
    const docsent = readFileSync(join(__dirname, '..', '..', 'src', 'workbench-docsent.ts'), 'utf8')
    const fn = docsent.slice(docsent.indexOf('export function markSentManually'), docsent.indexOf('export function sentMarkOf') > 0 ? docsent.indexOf('/** How a hand-marked item') : undefined)
    expect(fn).toContain("c.method === 'email'")
    expect(fn).toContain('writeEmailProof(item')
  })

  // Boss 2026-11-20: "when the user presses 'sent by e-mail' the system must look into the e-mails and write the subject,
  // the body, the sender ... into the txt, not write that it did not look".
  it('the proof of a found mail carries the TEXT of the mail', () => {
    const t = buildEmailProofText({ ...info, body: 'Dear Mr. Edmundson,\r\n\r\nPlease find attached my letter.' })
    expect(t).toContain('A levél szövege:')
    expect(t).toContain('Dear Mr. Edmundson,')
    expect(t).toContain('Please find attached my letter.')
  })

  it('a hand mark whose mail was not found says which Sent mailboxes were searched, not "did not read"', () => {
    const t = buildEmailProofText({ date: '2026-11-19', to: 'x@y.z', byHand: true, searched: ['usalackor', 'lackor2'] })
    expect(t).toContain('megnézte az Elküldött mappát (usalackor, lackor2)')
    expect(t).not.toContain('nem olvasta ki')
    // No account could be searched: the proof must not claim that it looked.
    const none = buildEmailProofText({ date: '2026-11-19', to: 'x@y.z', byHand: true })
    expect(none).toContain('nem tudta megnézni')
    expect(none).not.toContain('megnézte az Elküldött mappát')
  })

  it('pickSentMail takes the mail by the attachment names, else by the recipient address near the day', () => {
    const msgs = [
      { id: '1', date: '2026-11-19T14:00:00+01:00', to: 'matt@e.com', messageId: '<a>', attachments: ['Letter - v1.pdf'] },
      { id: '2', date: '2026-11-19T15:00:00+01:00', to: 'other@e.com', messageId: '<b>', attachments: ['x.pdf'] },
      { id: '3', date: '2026-11-01T15:00:00+01:00', to: 'matt@e.com', messageId: '<c>', attachments: [] },
    ]
    expect(pickSentMail(msgs, new Set(['letter - v1.pdf']), {})?.messageId).toBe('<a>')
    expect(pickSentMail(msgs, new Set(), { recipient: 'Matthew <matt@e.com>', date: '2026-11-19' })?.messageId).toBe('<a>')
    expect(pickSentMail(msgs, new Set(), { recipient: 'matt@e.com', date: '2026-11-25' })).toBeNull()
    expect(pickSentMail(msgs, new Set(), { recipient: 'Matthew Edmundson' })).toBeNull()
    expect(addressesIn('A <A@x.de>, b@y.com')).toEqual(['a@x.de', 'b@y.com'])
  })

  it('the full proof replaces the proof that was written for the same day when the mail was not found', () => {
    mkdirSync(join(depot, 'Projektek', 'P', 'Munkadarabok', 'Level'), { recursive: true })
    const c = createProject({ name: 'P', folder_path: 'Projektek/P' })
    if (!c.ok) throw new Error('create failed')
    const item = { id: 'it1', project_id: c.project.id, title: 'Level' } as never
    expect(writeEmailProof(item, { date: '2026-11-09', to: 'Matthew', byHand: true, searched: ['usalackor'] })).toBe(true)
    const dir = join(depot, 'Projektek', 'P', 'Munkadarabok', 'Level', 'Feladási bizonylatok')
    expect(readdirSync(dir).length).toBe(1)
    expect(writeEmailProof(item, { ...info, body: 'Hello' })).toBe(true)
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    const txt = readFileSync(join(dir, files[0] as string), 'utf8')
    expect(txt).toContain('<m1@x>')
    expect(txt).toContain('Hello')
    expect(txt).not.toContain('kézzel')
  })

  it('wiring: the hand mark starts the mailbox search (a writer registered by the sent-detect module), and the port reads the text', () => {
    const root = join(__dirname, '..', '..')
    const docsent = readFileSync(join(root, 'src', 'workbench-docsent.ts'), 'utf8')
    expect(docsent).toContain('handProofWriter(itemId')
    const det = readFileSync(join(root, 'src', 'workbench-sent-detect.ts'), 'utf8')
    expect(det).toContain('registerHandProofWriter(')
    expect(det).toContain('port.body(')
    expect(readFileSync(join(root, 'src', 'web', 'routes', 'email.ts'), 'utf8')).toContain('readMessageBody(accountId, mailbox, id)')
  })
})
