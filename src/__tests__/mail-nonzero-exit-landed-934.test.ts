// #934: himalaya v2.0.0 stores/sends a big message and then exits 1 ("Resource temporarily unavailable (os error 11)").
// The folder decides, not the exit code; a retry of a landed compose would file the draft twice.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeArgs, composeTarget, envelopeLanded } from '../mail-send.js'

const mail = { to: 'Sarah.Jaeckle@stadt-chemnitz.de, x@y.hu', subject: 'Az. 1 – Teszt', body: 'b', attachments: ['/tmp/a.pdf'] }

describe('composeTarget', () => {
  it('reads the folder, subject and recipient back from the compose arguments', () => {
    const t = composeTarget(composeArgs('acc', 'me@x.hu', mail, { send: true, saveTo: '[Gmail]/Elküldött levelek' }))
    expect(t).toEqual({ account: 'acc', folder: '[Gmail]/Elküldött levelek', subject: 'Az. 1 – Teszt', to: 'Sarah.Jaeckle@stadt-chemnitz.de, x@y.hu' })
  })
  it('is null for a call that saves nothing', () => {
    expect(composeTarget(['-a', 'acc', 'message', 'reply', '5', '--send'])).toBeNull()
  })
})

describe('envelopeLanded', () => {
  const t = { subject: 'Az. 1 – Teszt', to: 'Sarah.Jaeckle@stadt-chemnitz.de, x@y.hu' }
  const since = Date.parse('2026-11-17T16:18:00Z')
  it('finds the message that landed after the start', () => {
    expect(envelopeLanded([{ subject: 'Az. 1 – Teszt', date: '2026-11-17T16:18:32Z', to: [{ email: 'sarah.jaeckle@stadt-chemnitz.de' }] }], t, since)).toBe(true)
  })
  it('does not take an older message of the same subject', () => {
    expect(envelopeLanded([{ subject: 'Az. 1 – Teszt', date: '2026-11-17T15:44:15Z', to: [{ email: 'sarah.jaeckle@stadt-chemnitz.de' }] }], t, since)).toBe(false)
  })
  it('does not take another subject or another recipient', () => {
    expect(envelopeLanded([{ subject: 'Más', date: '2026-11-17T16:18:32Z', to: [{ email: 'sarah.jaeckle@stadt-chemnitz.de' }] }], t, since)).toBe(false)
    expect(envelopeLanded([{ subject: 'Az. 1 – Teszt', date: '2026-11-17T16:18:32Z', to: [{ email: 'other@x.hu' }] }], t, since)).toBe(false)
  })
})

describe('the mailbox engine uses the folder check', () => {
  const src = readFileSync(join(__dirname, '../web/routes/email.ts'), 'utf-8')
  it('send and draft save both ask the folder after a failed compose, and the draft save does not blindly retry', () => {
    expect(src).toContain('composeLandedInFolder(args, t0)')
    const compose = src.slice(src.indexOf('compose: async (args) => {'), src.indexOf('onSaved: (id, folder)'))
    expect(compose).toContain('himalayaOnce(args)')
    expect(compose).not.toContain('himalayaRead(args)')
  })
})
