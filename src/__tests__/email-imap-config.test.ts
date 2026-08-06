import { describe, it, expect } from 'vitest'
import { _internal } from '../web/email-imap.js'

const { parseHimalayaToml, parseImapServer } = _internal

const SYNTHETIC_CONFIG = `[accounts.testuser]
default = true
mailbox.alias.inbox = "Inbox"
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "testuser@example.com"
imap.sasl.plain.password.command = "cat /fake/path/testuser.txt"

smtp.server = "smtps://smtp.example.com:465"
smtp.sasl.plain.username = "testuser@example.com"
smtp.sasl.plain.password.command = "cat /fake/path/testuser.txt"

[accounts.plaintextimap]
imap.server = "imap://mail.example.org:143"
imap.sasl.plain.username = "plain@example.org"
imap.sasl.plain.password.command = "cat /fake/path/plain.txt"

[accounts.oauthuser]
imap.server = "imaps://imap.example.com:993"
imap.sasl.xoauth2.username = "oauth@example.com"
`

describe('parseHimalayaToml', () => {
  it('parses both real-shaped accounts with their dotted keys', () => {
    const accounts = parseHimalayaToml(SYNTHETIC_CONFIG)
    expect(accounts.size).toBe(3)
    const testuser = accounts.get('testuser')
    expect(testuser?.['imap.server']).toBe('imaps://imap.example.com:993')
    expect(testuser?.['imap.sasl.plain.username']).toBe('testuser@example.com')
    expect(testuser?.['imap.sasl.plain.password.command']).toBe('cat /fake/path/testuser.txt')
  })

  it('does not confuse imap.* keys with smtp.* keys under the same account', () => {
    const accounts = parseHimalayaToml(SYNTHETIC_CONFIG)
    const testuser = accounts.get('testuser')
    expect(testuser?.['smtp.server']).toBe('smtps://smtp.example.com:465')
    expect(testuser?.['imap.server']).not.toBe(testuser?.['smtp.server'])
  })

  it('an account with no password.command key (oauth) still parses -- resolver rejects it, not the tokenizer', () => {
    const accounts = parseHimalayaToml(SYNTHETIC_CONFIG)
    const oauth = accounts.get('oauthuser')
    expect(oauth).toBeDefined()
    expect(oauth?.['imap.sasl.plain.password.command']).toBeUndefined()
  })

  it('returns an empty map for malformed/empty input instead of throwing', () => {
    expect(parseHimalayaToml('').size).toBe(0)
    expect(parseHimalayaToml('not a toml file at all\n===broken===').size).toBe(0)
  })

  it('ignores non-account sections', () => {
    const accounts = parseHimalayaToml('[general]\nfoo = "bar"\n\n[accounts.real]\nimap.server = "imaps://x:993"\n')
    expect(accounts.size).toBe(1)
    expect(accounts.get('real')?.['imap.server']).toBe('imaps://x:993')
  })
})

describe('parseImapServer', () => {
  it('imaps:// is secure with the given port', () => {
    expect(parseImapServer('imaps://imap.example.com:993')).toEqual({ host: 'imap.example.com', port: 993, secure: true })
  })

  it('imap:// is not secure, custom port honoured', () => {
    expect(parseImapServer('imap://mail.example.org:143')).toEqual({ host: 'mail.example.org', port: 143, secure: false })
  })

  it('defaults port to 993 for imaps:// with no explicit port', () => {
    expect(parseImapServer('imaps://imap.example.com')).toEqual({ host: 'imap.example.com', port: 993, secure: true })
  })

  it('defaults port to 143 for imap:// with no explicit port', () => {
    expect(parseImapServer('imap://mail.example.org')).toEqual({ host: 'mail.example.org', port: 143, secure: false })
  })

  it('returns null for an unrecognised scheme rather than guessing', () => {
    expect(parseImapServer('smtps://not-imap.example.com:465')).toBeNull()
    expect(parseImapServer('garbage')).toBeNull()
  })
})
