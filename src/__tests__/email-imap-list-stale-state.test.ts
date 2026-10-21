import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Behaviour test for the Drafts ghost list (#729): the direct IMAP connection is long-lived and
// runs without IDLE, so the server's EXISTS/EXPUNGE updates only reach `mailbox.exists` when a
// command runs. The fake client below behaves like that: the server-side message list changes
// at any time, but `mailbox.exists` follows it only on noop().
const state = vi.hoisted(() => {
  const home = `${process.env.TMPDIR || '/tmp'}/marveen-stale-list-${process.pid}-${Date.now()}`
  process.env.HOME = home
  return { home, server: [] as Array<{ uid: number; subject: string }>, connects: 0 }
})

vi.mock('imapflow', () => {
  class FakeImapFlow {
    mailbox: { exists: number } | false = false
    on() { return this }
    async connect() { state.connects++ }
    async logout() {}
    async noop() { if (this.mailbox) this.mailbox.exists = state.server.length }
    async getMailboxLock() {
      // A SELECT reads the current count; a second lock on the already-selected mailbox does not.
      if (!this.mailbox) this.mailbox = { exists: state.server.length }
      return { release() {} }
    }
    async fetchAll(range: string) {
      const [from, to] = range.split(':').map(Number)
      return state.server.slice(from - 1, to).map((m, i) => ({
        uid: m.uid,
        seq: from + i,
        envelope: { subject: m.subject, from: [{ address: 'a@b.hu' }], to: [], date: new Date(0), messageId: `<${m.uid}@x>` },
        flags: new Set<string>(['\\Draft']),
        bodyStructure: { size: 10 },
      }))
    }
    async search() { return [] }
  }
  return { ImapFlow: FakeImapFlow }
})

let listEnvelopesDirect: typeof import('../web/email-imap.js').listEnvelopesDirect

beforeAll(async () => {
  const dir = join(state.home, '.local', 'share', 'marveen-himalaya')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.toml'), [
    '[accounts.t]',
    'imap.server = "imaps://imap.example.test:993"',
    'imap.sasl.plain.username = "t@example.test"',
    'imap.sasl.plain.password.command = "echo pw"',
    '',
  ].join('\n'))
  ;({ listEnvelopesDirect } = await import('../web/email-imap.js'))
})

const ids = (l: Array<{ id: string }> | null) => (l ?? []).map(e => e.id)

describe('listEnvelopesDirect on a long-lived connection (Drafts ghost list)', () => {
  it('shows a draft saved elsewhere, and drops a draft deleted elsewhere, on the very next listing', async () => {
    state.server = [{ uid: 10, subject: 'old' }]
    expect(ids(await listEnvelopesDirect('t', '[Gmail]/Piszkozatok', 1, 50))).toEqual(['10'])

    state.server = [{ uid: 10, subject: 'old' }, { uid: 11, subject: 'new' }]
    expect(ids(await listEnvelopesDirect('t', '[Gmail]/Piszkozatok', 1, 50))).toEqual(['11', '10'])

    state.server = [{ uid: 11, subject: 'new' }]
    expect(ids(await listEnvelopesDirect('t', '[Gmail]/Piszkozatok', 1, 50))).toEqual(['11'])

    state.server = []
    expect(ids(await listEnvelopesDirect('t', '[Gmail]/Piszkozatok', 1, 50))).toEqual([])
    expect(state.connects).toBe(1)
  })
})
