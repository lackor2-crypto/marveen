// #939 (Boss TG 6910): a 19 MB letter took ~2.5 minutes to send. Measured 2026-11-20: Gmail SMTP takes the upload at ~32 Mbit/s,
// but the `--save` copy (an IMAP APPEND of the whole message again) goes up at 2 Mbit/s, and Gmail already files an SMTP-sent
// message into Sent by itself. So a Gmail send must not carry --save, but must still look for the message in the Sent folder.
import { describe, it, expect, afterEach } from 'vitest'
import { composeArgs, composeTarget, registerMailboxEngine, sendMail, smtpFilesSentCopy, type MailboxEngine } from '../mail-send.js'

afterEach(() => registerMailboxEngine(null))

function engine(filesCopy: boolean | undefined, calls: Array<{ args: string[]; landedIn?: string }>): MailboxEngine {
  return {
    accounts: () => [{ id: 'acc', address: 'me@x.hu' }],
    run: async (args, opts) => { calls.push({ args, landedIn: opts?.landedIn }); return { ok: true, detail: '' } },
    ...(filesCopy === undefined ? {} : { filesSentCopy: () => filesCopy }),
    sentFolder: async () => '[Gmail]/Sent Mail',
    changed: () => {},
    saveDraft: async () => ({ ok: true }),
  }
}

const mail = { to: 'a@b.hu', subject: 'Betreff', body: 'hello', attachments: ['/tmp/x.pdf'] }

describe('which SMTP servers file the sent message themselves', () => {
  it('Gmail does (measured), others are not assumed to', () => {
    expect(smtpFilesSentCopy('smtps://smtp.gmail.com:465')).toBe(true)
    expect(smtpFilesSentCopy('smtp://smtp.googlemail.com:587')).toBe(true)
    expect(smtpFilesSentCopy('smtps://mail.example.hu:465')).toBe(false)
    expect(smtpFilesSentCopy('smtps://smtp.gmail.com.evil.example:465')).toBe(false)
    expect(smtpFilesSentCopy(undefined)).toBe(false)
  })
})

describe('compose arguments without a saved copy', () => {
  it('an empty saveTo leaves --save out, a folder keeps it', () => {
    expect(composeArgs('acc', 'me@x.hu', mail, { send: true, saveTo: '' })).not.toContain('--save')
    expect(composeArgs('acc', 'me@x.hu', mail, { send: true, saveTo: 'Sent' })).toContain('--save')
  })
  it('the folder to look in comes from landedIn when there is no --save', () => {
    const args = composeArgs('acc', 'me@x.hu', mail, { send: true, saveTo: '' })
    expect(composeTarget(args)).toBeNull()
    expect(composeTarget(args, '[Gmail]/Sent Mail')).toMatchObject({ account: 'acc', folder: '[Gmail]/Sent Mail', subject: 'Betreff', to: 'a@b.hu' })
  })
})

describe('sendMail', () => {
  it('on a server that files its own copy: no --save, and the Sent folder is handed over for the non-zero-exit check', async () => {
    const calls: Array<{ args: string[]; landedIn?: string }> = []
    registerMailboxEngine(engine(true, calls))
    const r = await sendMail('acc', mail)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toContain('--send')
    expect(calls[0].args).not.toContain('--save')
    expect(calls[0].landedIn).toBe('[Gmail]/Sent Mail')
  })
  it('on any other server (or one that does not say): the copy is still appended into Sent', async () => {
    for (const flag of [false, undefined]) {
      const calls: Array<{ args: string[]; landedIn?: string }> = []
      registerMailboxEngine(engine(flag, calls))
      await sendMail('acc', mail)
      expect(calls[0].args).toContain('--save')
      expect(calls[0].args[calls[0].args.indexOf('--save') + 1]).toBe('[Gmail]/Sent Mail')
      expect(calls[0].landedIn).toBeUndefined()
    }
  })
})
