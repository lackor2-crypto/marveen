import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The direct IMAP connection runs with disableAutoIdle, so the server's EXISTS /
// EXPUNGE updates are only read when a command runs. listEnvelopesDirect builds its
// sequence band from mailbox.exists, so it must NOOP first; otherwise a deleted draft
// keeps showing and a saved one does not (Boss, 2026-10-21).
describe('listEnvelopesDirect refreshes the mailbox state before using exists', () => {
  it('calls client.noop() before reading mailbox.exists', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'email-imap.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export async function listEnvelopesDirect'))
    const noopAt = fn.indexOf('client.noop()')
    const existsAt = fn.indexOf('mailboxInfo.exists')
    expect(noopAt).toBeGreaterThan(-1)
    expect(existsAt).toBeGreaterThan(noopAt)
  })
})
