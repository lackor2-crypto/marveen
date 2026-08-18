// The email folder column has now broken three times the same way, and Boss put
// it plainly (2026-08-12): "nem lehet egy ido utan mindenre figyelni. hogy egy
// javitas miatt mi romlik el. ezt kuszobold ki valahogy! de biztosra!"
//
// What breaks is never the folder list itself -- it is the NAMES. A mailbox name
// is a contract between three places that are edited by different people at
// different times:
//
//   1. the direct IMAP path (this file's subject) produces them,
//   2. the frontend pins the system folders (web/app.js),
//   3. every read/move/flag call sends the same string back, and the himalaya
//      fallback has to accept it.
//
// Nothing about that is visible to a type checker. The second regression
// returned a perfectly valid list of perfectly real folders ("Kuka" instead of
// "[Gmail]/Kuka"). The third was worse and had been latent from the start: the
// name is in the ACCOUNT's own Gmail language, so the day Boss added an
// English-language account (2026-08-18, freeberischeaper@gmail.com) delete came
// back "Command failed ... -t [Gmail]/Kuka" and every system folder in the
// column silently demoted itself to a custom label.
//
// So the pinning is by ROLE now, read from the language-independent IMAP flags,
// and this test holds both ends of that: the backend must derive the roles the
// frontend orders by, and it must derive the SAME roles whatever language the
// account speaks.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  himalayaMailboxName,
  mapDirectMailboxes,
  mailboxRoleFromFlags,
  specialMailboxesFrom,
} from '../web/email-imap.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_JS = join(__dirname, '..', '..', 'web', 'app.js')
const EMAIL_IMAP_TS = join(__dirname, '..', 'web', 'email-imap.ts')

/** The roles the folder column pins, read from the frontend itself. */
function frontendRoles(): string[] {
  const src = readFileSync(APP_JS, 'utf8')
  const m = src.match(/const EMAIL_SYSTEM_MAILBOX_ROLE_ORDER = \[([^\]]*)\]/)
  expect(m, 'EMAIL_SYSTEM_MAILBOX_ROLE_ORDER not found in web/app.js').not.toBeNull()
  return m![1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(x => x.length > 0)
}

/** The roles the backend knows about, read from the MailboxRole union itself. */
function backendRoles(): string[] {
  const src = readFileSync(EMAIL_IMAP_TS, 'utf8')
  const m = src.match(/export type MailboxRole = ([^\n]+)/)
  expect(m, 'MailboxRole not found in src/web/email-imap.ts').not.toBeNull()
  return m![1].split('|').map(x => x.trim().replace(/^'|'$/g, '')).filter(x => x.length > 0)
}

// The two live accounts this was measured against on 2026-08-18. Same flags,
// different names -- which is the entire point.
const HU_ACCOUNT = [
  { path: 'INBOX', flags: new Set<string>() },
  { path: '[Gmail]/Elküldött levelek', flags: new Set(['\\Sent']) },
  { path: '[Gmail]/Piszkozatok', flags: new Set(['\\Drafts']) },
  { path: '[Gmail]/Kuka', flags: new Set(['\\Trash']) },
  { path: '[Gmail]/Spam', flags: new Set(['\\Junk']) },
  { path: '[Gmail]/Fontos', flags: new Set(['\\Important']) },
  { path: '[Gmail]/Csillagozott', flags: new Set(['\\Flagged']) },
  { path: '[Gmail]/Összes levél', flags: new Set(['\\All']) },
  { path: 'Personal', flags: new Set<string>() },
]
const EN_ACCOUNT = [
  { path: 'INBOX', flags: new Set<string>() },
  { path: '[Gmail]/Sent Mail', flags: new Set(['\\Sent']) },
  { path: '[Gmail]/Drafts', flags: new Set(['\\Drafts']) },
  { path: '[Gmail]/Trash', flags: new Set(['\\Trash']) },
  { path: '[Gmail]/Spam', flags: new Set(['\\Junk']) },
  { path: '[Gmail]/Important', flags: new Set(['\\Important']) },
  { path: '[Gmail]/Starred', flags: new Set(['\\Flagged']) },
  { path: '[Gmail]/All Mail', flags: new Set(['\\All']) },
  { path: 'Stripe', flags: new Set<string>() },
]

describe('himalayaMailboxName', () => {
  it('renders the inbox the way himalaya does, whatever case the server used', () => {
    expect(himalayaMailboxName('INBOX')).toBe('Inbox')
    expect(himalayaMailboxName('Inbox')).toBe('Inbox')
    expect(himalayaMailboxName('inbox')).toBe('Inbox')
  })

  it('keeps every other folder at its FULL path, not its leaf segment', () => {
    // The second regression: "[Gmail]/Kuka" arrived as "Kuka".
    expect(himalayaMailboxName('[Gmail]/Kuka')).toBe('[Gmail]/Kuka')
    expect(himalayaMailboxName('Freeber/Developp/Peter Botond')).toBe('Freeber/Developp/Peter Botond')
  })
})

describe('mailboxRoleFromFlags', () => {
  it('reads the role from the flag, not from the name', () => {
    expect(mailboxRoleFromFlags('[Gmail]/Kuka', new Set(['\\Trash']))).toBe('trash')
    expect(mailboxRoleFromFlags('[Gmail]/Trash', new Set(['\\Trash']))).toBe('trash')
    // A user label that merely LOOKS like a system folder is still a label.
    expect(mailboxRoleFromFlags('Kuka', new Set<string>())).toBeNull()
    expect(mailboxRoleFromFlags('[Gmail]/Trash', new Set<string>())).toBeNull()
  })

  it('recognises the inbox by path -- it carries no flag of its own', () => {
    // Measured: imapflow reports INBOX with specialUse "\Inbox" but an EMPTY
    // flag set, so a flags-only lookup would miss the one folder that matters
    // most (and mapDirectMailboxes refuses any list without it).
    expect(mailboxRoleFromFlags('INBOX', new Set(['\\HasNoChildren']))).toBe('inbox')
    expect(mailboxRoleFromFlags('inbox', undefined)).toBe('inbox')
  })

  it('recognises Gmail\'s non-standard Important, which is not a special-use flag', () => {
    // imapflow lifts only the RFC 6154 set into `specialUse`, so reading that
    // instead of `flags` would silently lose Important on every account.
    expect(mailboxRoleFromFlags('[Gmail]/Fontos', new Set(['\\Important']))).toBe('important')
    expect(mailboxRoleFromFlags('[Gmail]/Important', new Set(['\\Important']))).toBe('important')
  })

  it('accepts flags as an array as well as a Set', () => {
    expect(mailboxRoleFromFlags('[Gmail]/Sent Mail', ['\\HasNoChildren', '\\Sent'])).toBe('sent')
  })
})

describe('the folder column pins the same folders in any Gmail language', () => {
  it('derives identical roles from a Hungarian and an English account', () => {
    const hu = specialMailboxesFrom(mapDirectMailboxes(HU_ACCOUNT)!)
    const en = specialMailboxesFrom(mapDirectMailboxes(EN_ACCOUNT)!)
    expect(Object.keys(hu).sort()).toEqual(Object.keys(en).sort())
    // ...while the NAMES are genuinely different, which is why this exists.
    expect(hu.trash).toBe('[Gmail]/Kuka')
    expect(en.trash).toBe('[Gmail]/Trash')
    expect(hu.sent).toBe('[Gmail]/Elküldött levelek')
    expect(en.sent).toBe('[Gmail]/Sent Mail')
  })

  it('resolves every role the delete/move/compose routes ask for', () => {
    // These are what a broken resolution actually costs the user: delete
    // (trash), the Sent list and compose --save (sent), the spam rule (spam)
    // and the star/important toggle (important).
    for (const account of [HU_ACCOUNT, EN_ACCOUNT]) {
      const resolved = specialMailboxesFrom(mapDirectMailboxes(account)!)
      for (const role of ['trash', 'sent', 'spam', 'important', 'drafts', 'starred', 'all', 'inbox'] as const) {
        expect(resolved[role], `${role} unresolved`).toBeTruthy()
      }
    }
  })

  it('leaves user labels roleless, so they still sort as labels', () => {
    const en = mapDirectMailboxes(EN_ACCOUNT)!
    expect(en.find(mb => mb.name === 'Stripe')!.role).toBeNull()
  })
})

describe('the frontend and the backend agree on the role vocabulary', () => {
  // 'chats' is display-only: Gmail's Chats folder carries no special-use flag
  // and does not exist on either live account, so the frontend keeps it purely
  // as a name-based fallback and the backend never emits it.
  const DISPLAY_ONLY = new Set(['chats'])

  it('pins every role the backend can produce', () => {
    const pinned = new Set(frontendRoles())
    for (const role of backendRoles()) {
      expect(pinned.has(role), `web/app.js does not order the "${role}" folder`).toBe(true)
    }
  })

  it('pins no role the backend cannot produce', () => {
    const known = new Set(backendRoles())
    for (const role of frontendRoles()) {
      if (DISPLAY_ONLY.has(role)) continue
      expect(known.has(role), `web/app.js pins "${role}", which MailboxRole has no case for`).toBe(true)
    }
  })
})

describe('mapDirectMailboxes', () => {
  const inbox = { path: 'INBOX', flags: new Set<string>() }

  it('drops non-selectable pseudo-mailboxes', () => {
    const mapped = mapDirectMailboxes([inbox, { path: '[Gmail]', flags: new Set(['\\Noselect']) }])
    expect(mapped!.map((mb) => mb.name)).toEqual(['Inbox'])
  })

  it('accepts flags as an array as well as a Set', () => {
    const mapped = mapDirectMailboxes([{ path: 'INBOX', flags: [] }, { path: '[Gmail]', flags: ['\\Noselect'] }])
    expect(mapped!.map((mb) => mb.name)).toEqual(['Inbox'])
  })

  it('uses the name for the id too, the way himalaya does, and carries the role', () => {
    expect(mapDirectMailboxes([inbox])).toEqual([
      { id: 'Inbox', name: 'Inbox', total: null, unread: null, role: 'inbox' },
    ])
  })

  // The guard that makes this "biztosra" rather than "we tested it": a list
  // without an inbox is refused outright, so the caller falls back to the slower
  // path instead of rendering a folder column with no Beérkező levelek in it.
  it('refuses a list with no inbox, however plausible it looks', () => {
    expect(mapDirectMailboxes([
      { path: 'Kuka', flags: new Set<string>() },
      { path: 'Piszkozatok', flags: new Set<string>() },
    ])).toBeNull()
  })

  it('refuses an empty list', () => {
    expect(mapDirectMailboxes([])).toBeNull()
  })
})

describe('specialMailboxesFrom', () => {
  it('keeps the first name for a role and ignores roleless mailboxes', () => {
    const resolved = specialMailboxesFrom([
      { id: 'Inbox', name: 'Inbox', total: null, unread: null, role: 'inbox' },
      { id: '[Gmail]/Kuka', name: '[Gmail]/Kuka', total: null, unread: null, role: 'trash' },
      { id: 'Impostor', name: 'Impostor', total: null, unread: null, role: 'trash' },
      { id: 'Stripe', name: 'Stripe', total: null, unread: null, role: null },
    ])
    expect(resolved).toEqual({ inbox: 'Inbox', trash: '[Gmail]/Kuka' })
  })
})
