import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #886 (continued): the Enter/"Keresés" archive search was fixed (one all-mail query, failures shown), but the
// search-as-you-type scopes (from/to/subject/date/all) still went through emailFetchAllMailboxEnvelopes: one request
// PER mailbox, all at once (dozens of ~20 s IMAP reads that froze the dashboard), and a failed read was silently
// turned into an empty list -> a false "Nincs találat". Behavioural test: the real functions from web/app.js run
// against a fake fetch.
const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const start = app.indexOf('async function emailFetchMailboxEnvelopes(')
const end = app.indexOf('// Boss, 2026-08-09 (several voice messages, correcting the first attempt')
const src = app.slice(start, end)

function load(fetchImpl: (url: string) => Promise<any>) {
  const factory = new Function('fetch', 'emailAccount', 'emailScopedMailboxCache',
    `${src}\nreturn { emailFetchMailboxEnvelopes, emailFetchAllMailboxEnvelopes }`)
  return factory(fetchImpl, 'acc', {}) as {
    emailFetchMailboxEnvelopes: (n: string) => Promise<unknown[] | null>
    emailFetchAllMailboxEnvelopes: () => Promise<any>
  }
}

const names = Array.from({ length: 12 }, (_, i) => `box${i}`)

function fakeFetch(opts: { failFor?: string[]; track?: { cur: number; max: number } }) {
  return async (url: string) => {
    if (url.startsWith('/api/email/mailboxes')) return { ok: true, json: async () => names.map(name => ({ name })) }
    const mailbox = new URLSearchParams(url.split('?')[1]).get('mailbox') as string
    const t = opts.track
    if (t) { t.cur++; t.max = Math.max(t.max, t.cur) }
    await new Promise(r => setTimeout(r, 5))
    if (t) t.cur--
    if (opts.failFor?.includes(mailbox)) throw new Error('boom')
    return { ok: true, json: async () => [{ id: mailbox, subject: 's' }] }
  }
}

describe('search-as-you-type over every mailbox', () => {
  it('never runs more than 3 mailbox reads at the same time', async () => {
    const track = { cur: 0, max: 0 }
    const { emailFetchAllMailboxEnvelopes } = load(fakeFetch({ track }))
    const r = await emailFetchAllMailboxEnvelopes()
    expect(track.max).toBeLessThanOrEqual(3)
    expect(r.merged).toHaveLength(12)
    expect(r.failed).toBe(0)
  })

  it('five keystrokes on a cold cache read every mailbox ONCE, not once per keystroke', async () => {
    const track = { cur: 0, max: 0 }
    const seen: Record<string, number> = {}
    const inner = fakeFetch({ track })
    const counting = async (url: string) => {
      if (!url.startsWith('/api/email/mailboxes')) { const m = new URLSearchParams(url.split('?')[1]).get('mailbox') as string; seen[m] = (seen[m] || 0) + 1 }
      return inner(url)
    }
    const { emailFetchAllMailboxEnvelopes } = load(counting)
    const runs = await Promise.all([1, 2, 3, 4, 5].map(() => emailFetchAllMailboxEnvelopes()))
    expect(Object.values(seen).every(n => n === 1)).toBe(true)
    expect(Object.keys(seen)).toHaveLength(12)
    expect(track.max).toBeLessThanOrEqual(3)
    runs.forEach(r => expect(r.merged).toHaveLength(12))
  })

  it('reports a failed mailbox read instead of treating it as empty, and does not cache it', async () => {
    const { emailFetchMailboxEnvelopes, emailFetchAllMailboxEnvelopes } = load(fakeFetch({ failFor: ['box3', 'box7'] }))
    const r = await emailFetchAllMailboxEnvelopes()
    expect(r.failed).toBe(2)
    expect(r.merged).toHaveLength(10)
    expect(await emailFetchMailboxEnvelopes('box3')).toBeNull()
  })
})

describe('a failed mailbox LIST read', () => {
  it('is reported as a failure, not turned into "no mailboxes", and is not cached', async () => {
    let listCalls = 0
    let listOk = false
    const inner = fakeFetch({})
    const flaky = async (url: string) => {
      if (url.startsWith('/api/email/mailboxes')) {
        listCalls++
        if (!listOk) throw new Error('boom')
      }
      return inner(url)
    }
    const { emailFetchAllMailboxEnvelopes } = load(flaky)
    const first = await emailFetchAllMailboxEnvelopes()
    expect(first.merged).toHaveLength(0)
    expect(first.failed).toBeGreaterThan(0)
    listOk = true
    const second = await emailFetchAllMailboxEnvelopes()
    expect(listCalls).toBe(2)
    expect(second.failed).toBe(0)
    expect(second.merged).toHaveLength(12)
  })
})

describe('the dropdown shows the failure, not "no matches"', () => {
  it('uses email.search_failed in the typing path when nothing matched and a read failed', () => {
    const fn = app.slice(app.indexOf('async function emailUpdateSearchDropdown('), app.indexOf('function emailRenderSearchDropdown('))
    expect(fn + app.slice(app.indexOf('function emailShowSearchFailed('), app.indexOf('function emailRenderSearchDropdown('))).toContain("t('email.search_failed'")
    expect(fn).toContain('emailShowSearchFailed(failed)')
  })
})

describe('Enter / "Keresés" archive search with an unreadable mailbox list', () => {
  it('shows the failure (email.search_failed) instead of "no matches" or a crash', () => {
    const fn = app.slice(app.indexOf('async function emailRunContentSearch('), app.indexOf('function emailUpdateBulkDeleteUI('))
    expect(fn).toContain('if (!names) { emailShowSearchFailed(1); return }')
    expect(fn).not.toContain('boxes = []')
  })
})
