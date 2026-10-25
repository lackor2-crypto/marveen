// #797: every mail the app sends or saves as a draft goes through src/mail-send.ts, so the owner sees the same accounts at
// every send and a fix reaches every sender. This test keeps new direct senders out, and pins the shared road's behaviour.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  composeArgs, registerMailboxEngine, replyOrForward, saveDraft, sendMail, sendingAccounts, _setGoogleEngine,
  type MailboxEngine, type GoogleRunner,
} from '../mail-send.js'

const ROOT = join(__dirname, '..', '..')

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '__tests__' || name === 'vendor') continue
    const st = statSync(p)
    if (st.isDirectory()) files(p, out)
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}

describe('#797 one road for the app\'s mail', () => {
  // The Gmail sender is caught as the string a call needs (join(..., 'gmail-send.py')), not a mention in a comment.
  it('no app source outside src/mail-send.ts builds a himalaya send / compose or runs the Gmail sender', () => {
    const offenders: string[] = []
    for (const f of [...files(join(ROOT, 'src')), ...files(join(ROOT, 'web'))]) {
      const rel = relative(ROOT, f).replace(/\\/g, '/')
      if (rel === 'src/mail-send.ts') continue
      const src = readFileSync(f, 'utf8')
      if (/'--send'/.test(src) || /'message',\s*'(compose|reply|forward)'/.test(src) || /['"](?:[^'"\s]*\/)?gmail-send\.py['"]/.test(src) || /users\/me\/messages\/send/.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  // The agents' own command-line mail tools run outside the app; the only Graph sender is the M365 tool's library.
  it('the M365 Graph sender is used only by its command-line tool', () => {
    const users = files(join(ROOT, 'src')).map((f) => relative(ROOT, f).replace(/\\/g, '/'))
      .filter((rel) => rel !== 'src/graph-mail.ts' && /from '\.{1,2}\/(?:\.\.\/)*graph-mail\.js'/.test(readFileSync(join(ROOT, rel), 'utf8')))
    expect(users).toEqual([])
  })
})

describe('#797 the shared sender itself', () => {
  afterEach(() => { registerMailboxEngine(null); _setGoogleEngine(null) })

  function engine(over: Partial<MailboxEngine> = {}): MailboxEngine & { runs: string[][]; changes: string[]; drafts: unknown[] } {
    const runs: string[][] = []
    const changes: string[] = []
    const drafts: unknown[] = []
    return {
      accounts: () => [{ id: 'iroda', address: 'en@pelda.hu' }],
      run: async (args) => { runs.push(args); return { ok: true, detail: '' } },
      sentFolder: async () => '[Gmail]/Elküldött levelek',
      changed: (a, f) => { changes.push(`${a}:${f}`) },
      saveDraft: async (_a, m) => { drafts.push(m); return { ok: true, mailbox: '[Gmail]/Piszkozatok' } },
      runs, changes, drafts,
      ...over,
    }
  }

  it('the same account list everywhere: the mailbox accounts, then the Google one -- not twice for the same address', () => {
    registerMailboxEngine(engine())
    _setGoogleEngine(null, () => ({ key: 'me', address: 'en@gmail.com' }))
    expect(sendingAccounts()).toEqual([
      { id: 'iroda', address: 'en@pelda.hu', kind: 'mailbox' },
      { id: 'google', address: 'en@gmail.com', kind: 'google' },
    ])
    _setGoogleEngine(null, () => ({ key: 'me', address: 'EN@pelda.hu' }))
    expect(sendingAccounts().map((a) => a.id)).toEqual(['iroda'])
    // a fresh install: no account at all
    registerMailboxEngine(null)
    _setGoogleEngine(null, () => null)
    expect(sendingAccounts()).toEqual([])
  })

  it('a mailbox account: sent ONCE with a copy in its own Sent folder, the cached list dropped', async () => {
    const e = engine()
    registerMailboxEngine(e)
    _setGoogleEngine(null, () => null)
    const r = await sendMail('iroda', { to: 'ugyfel@pelda.hu', cc: 'masolat@pelda.hu', subject: 'Fellebbezés', body: 'Csatolva.', attachments: ['/tmp/a.pdf'] })
    expect(r).toMatchObject({ ok: true, account: 'iroda', kind: 'mailbox', mailbox: '[Gmail]/Elküldött levelek' })
    expect(e.runs).toEqual([['-a', 'iroda', 'message', 'compose', '--from', 'en@pelda.hu', '-t', 'ugyfel@pelda.hu', '--cc', 'masolat@pelda.hu', '-s', 'Fellebbezés', '--body', 'Csatolva.', '--send', '--save', '[Gmail]/Elküldött levelek', '--attach', '/tmp/a.pdf']])
    expect(e.changes).toEqual(['iroda:[Gmail]/Elküldött levelek'])
  })

  it('the Google account: the Gmail sender with the account, the body and the copy line', async () => {
    const got: unknown[] = []
    const runner: GoogleRunner = async (mode, mail, key) => { got.push({ mode, to: mail.to, cc: mail.cc, key }); return { ok: true, id: 'gm-1' } }
    _setGoogleEngine(runner, () => ({ key: 'me', address: 'en@gmail.com' }))
    expect(await sendMail('google', { to: 'a@b.hu', cc: 'c@d.hu', subject: 'S', body: 'B', attachments: ['/tmp/x.html'] })).toMatchObject({ ok: true, kind: 'google', messageId: 'gm-1' })
    expect(await saveDraft('google', { to: 'a@b.hu', subject: 'S', body: 'B' })).toMatchObject({ ok: true, kind: 'google' })
    expect(got).toEqual([{ mode: 'send', to: 'a@b.hu', cc: 'c@d.hu', key: 'me' }, { mode: 'draft', to: 'a@b.hu', cc: undefined, key: 'me' }])
  })

  it('an unknown account sends nothing; a failure comes back with the real error text', async () => {
    const e = engine({ run: async () => ({ ok: false, detail: 'SMTP 535 authentication failed' }) })
    registerMailboxEngine(e)
    _setGoogleEngine(null, () => null)
    expect(await sendMail('nincs', { to: 'a@b.hu', subject: 'S', body: 'B' })).toMatchObject({ ok: false, code: 'unknown_account' })
    expect(await sendMail('iroda', { to: 'a@b.hu', subject: 'S', body: 'B' })).toEqual({ ok: false, code: 'send_failed', detail: 'SMTP 535 authentication failed' })
    expect(e.changes).toEqual([])
  })

  it('a draft goes through the engine\'s Drafts save (with its retry), never sent', async () => {
    const e = engine()
    registerMailboxEngine(e)
    _setGoogleEngine(null, () => null)
    const r = await saveDraft('iroda', { to: '', subject: 'Vázlat', body: '' })
    expect(r).toMatchObject({ ok: true, mailbox: '[Gmail]/Piszkozatok' })
    expect(e.runs).toEqual([])
    expect(e.drafts).toHaveLength(1)
  })

  it('a reply and a forward are the same engine, from the account\'s address', async () => {
    const e = engine()
    registerMailboxEngine(e)
    _setGoogleEngine(null, () => null)
    await replyOrForward('iroda', 'reply', { mailbox: 'Inbox', id: '42' }, { body: 'Köszönöm' })
    await replyOrForward('iroda', 'forward', { mailbox: 'Inbox', id: '42' }, { to: ' x@y.hu ', body: 'Nézd' })
    expect(e.runs).toEqual([
      ['-a', 'iroda', 'message', 'reply', '42', '-m', 'Inbox', '--from', 'en@pelda.hu', '--body', 'Köszönöm', '--send'],
      ['-a', 'iroda', 'message', 'forward', '42', '-m', 'Inbox', '--from', 'en@pelda.hu', '-t', 'x@y.hu', '--body', 'Nézd', '--send'],
    ])
    // a Google account is not a mailbox: no reply from it
    _setGoogleEngine(null, () => ({ key: 'me', address: 'en@gmail.com' }))
    expect(await replyOrForward('google', 'reply', { mailbox: 'Inbox', id: '1' }, { body: 'x' })).toMatchObject({ ok: false, code: 'unknown_account' })
  })

  it('compose arguments: an empty body is one newline, a draft is saved, not sent', () => {
    expect(composeArgs('a', 'me@x.hu', { to: '', subject: '', body: '  ' }, { send: false, saveTo: 'Drafts' }))
      .toEqual(['-a', 'a', 'message', 'compose', '--from', 'me@x.hu', '--body', '\n', '--save', 'Drafts'])
  })
})
