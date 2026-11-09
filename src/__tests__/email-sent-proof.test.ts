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
})
