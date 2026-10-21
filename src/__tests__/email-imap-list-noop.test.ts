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

// The route must not answer the Drafts list from the "stale but instant" cache either: a deleted draft came back
// after a refresh and a new one stayed out for minutes (#729).
describe('GET /api/email/envelopes reads the Drafts list fresh', () => {
  it('resolves the drafts folder and answers before consulting the envelope cache', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'email.ts'), 'utf8')
    const route = src.slice(src.indexOf("path === '/api/email/envelopes' && method === 'GET'"))
    const draftsAt = route.indexOf("resolveSpecialMailboxes(account as string)")
    const cacheAt = route.indexOf('cacheGet(envelopeListCache, envelopeCacheKey)')
    const staleAt = route.indexOf('cacheGetStale(envelopeListCache')
    expect(draftsAt).toBeGreaterThan(-1)
    expect(cacheAt).toBeGreaterThan(draftsAt)
    expect(staleAt).toBeGreaterThan(draftsAt)
  })
})
