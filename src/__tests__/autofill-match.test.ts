import { describe, it, expect } from 'vitest'
import { hostFromUrlLike, isUsableEntryHost, urlCoversPage, credentialsFromFields } from '../web/autofill-match.js'
import type { VaultField } from '../vault-fields.js'

// Card 21311fdb (#96). The contract this file pins down:
//   - a stored url covers the page it was saved for and the hosts UNDER it,
//     never a sibling and never a lookalike;
//   - a registry suffix ("com", "co.uk") is not a site and matches nothing;
//   - a card's fields yield one username/password pair per named group, and a
//     recovery code or API key is never offered as the password.

const f = (label: string, kind: VaultField['kind'], value: string, section?: string): VaultField =>
  ({ label, kind, value, ...(section ? { section } : {}) })

describe('hostFromUrlLike', () => {
  it('reads the host out of a full url', () => {
    expect(hostFromUrlLike('https://www.youtube.com/watch?v=1')).toBe('www.youtube.com')
  })
  it('accepts a bare host, which is what people type into a vault card', () => {
    expect(hostFromUrlLike('youtube.com')).toBe('youtube.com')
  })
  it('lowercases and drops the port and the root dot', () => {
    expect(hostFromUrlLike('HTTP://YouTube.com.:8080/x')).toBe('youtube.com')
  })
  it('is null for what has no host -- the caller must not read that as "matches anything"', () => {
    expect(hostFromUrlLike('')).toBeNull()
    expect(hostFromUrlLike('   ')).toBeNull()
    expect(hostFromUrlLike(undefined)).toBeNull()
    expect(hostFromUrlLike('about:blank')).toBeNull()
  })
})

describe('isUsableEntryHost', () => {
  it('rejects a bare label and a public suffix', () => {
    expect(isUsableEntryHost('localhost')).toBe(false)
    expect(isUsableEntryHost('com')).toBe(false)
    expect(isUsableEntryHost('co.uk')).toBe(false)
  })
  it('accepts a real site', () => {
    expect(isUsableEntryHost('youtube.com')).toBe(true)
    expect(isUsableEntryHost('shop.example.co.uk')).toBe(true)
  })
})

describe('urlCoversPage', () => {
  it('matches the same host', () => {
    expect(urlCoversPage('https://youtube.com', 'https://youtube.com/login')).toBe(true)
  })
  it('matches a host UNDER the stored one', () => {
    expect(urlCoversPage('youtube.com', 'https://www.youtube.com/account')).toBe(true)
    expect(urlCoversPage('google.com', 'https://mail.google.com/')).toBe(true)
  })
  it('does NOT widen a stored subdomain to its siblings', () => {
    expect(urlCoversPage('https://accounts.google.com', 'https://mail.google.com/')).toBe(false)
  })
  it('does NOT match a lookalike domain', () => {
    expect(urlCoversPage('youtube.com', 'https://evil-youtube.com/login')).toBe(false)
    expect(urlCoversPage('youtube.com', 'https://youtube.com.evil.tld/login')).toBe(false)
  })
  it('a registry suffix in the card matches nothing', () => {
    expect(urlCoversPage('com', 'https://youtube.com/login')).toBe(false)
    expect(urlCoversPage('co.uk', 'https://bank.co.uk/login')).toBe(false)
  })
  it('a card with no url matches nothing', () => {
    expect(urlCoversPage(undefined, 'https://youtube.com/login')).toBe(false)
    expect(urlCoversPage('', 'https://youtube.com/login')).toBe(false)
  })
})

describe('credentialsFromFields', () => {
  it('pairs a named username with a named password', () => {
    const creds = credentialsFromFields([
      f('Felhasználónév', 'text', 'boss@example.com'),
      f('Jelszó', 'secret', 'titok123'),
    ])
    expect(creds).toEqual([{ section: '', usernameLabel: 'Felhasználónév', username: 'boss@example.com', passwordLabel: 'Jelszó', password: 'titok123' }])
  })

  it('keeps two logins on one card apart by their group', () => {
    const creds = credentialsFromFields([
      f('E-mail', 'text', 'privat@example.com', 'Privát'),
      f('Password', 'secret', 'aaa', 'Privát'),
      f('E-mail', 'text', 'munka@example.com', 'Munkahelyi'),
      f('Password', 'secret', 'bbb', 'Munkahelyi'),
    ])
    expect(creds.map(c => [c.section, c.username, c.password])).toEqual([
      ['Privát', 'privat@example.com', 'aaa'],
      ['Munkahelyi', 'munka@example.com', 'bbb'],
    ])
  })

  it('takes a lone unlabelled secret as the password', () => {
    const creds = credentialsFromFields([f('Belépés', 'text', 'user1'), f('Titok', 'secret', 'pw')])
    expect(creds).toHaveLength(1)
    expect(creds[0]!.password).toBe('pw')
    expect(creds[0]!.username).toBe('user1')
  })

  it('never offers a recovery code or an API key as the password', () => {
    expect(credentialsFromFields([f('Felhasználónév', 'text', 'u'), f('Helyreállító kód', 'secret', 'zzz')])).toEqual([])
    expect(credentialsFromFields([f('API kulcs', 'secret', 'sk-1')])).toEqual([])
  })

  it('picks the real password when a recovery code sits beside it', () => {
    const creds = credentialsFromFields([
      f('Felhasználónév', 'text', 'u'),
      f('Jelszó', 'secret', 'pw'),
      f('Helyreállító kódok', 'secret', 'r1 r2 r3'),
    ])
    expect(creds).toHaveLength(1)
    expect(creds[0]!.password).toBe('pw')
  })

  it('a card with no password yields nothing -- the caller reports why', () => {
    expect(credentialsFromFields([f('Megjegyzés', 'text', 'semmi')])).toEqual([])
    expect(credentialsFromFields([])).toEqual([])
  })

  it('an empty password value does not count as a password', () => {
    expect(credentialsFromFields([f('Jelszó', 'secret', '')])).toEqual([])
  })

  it('falls back to the field above the password when nothing says "username"', () => {
    const creds = credentialsFromFields([f('Azonosító szám', 'text', '12345'), f('Jelszó', 'secret', 'pw')])
    expect(creds[0]!.username).toBe('12345')
  })
})
