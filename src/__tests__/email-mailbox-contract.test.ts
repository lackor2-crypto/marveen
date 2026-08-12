// The email folder column has now broken twice the same way, and Boss put it
// plainly (2026-08-12): "nem lehet egy ido utan mindenre figyelni. hogy egy
// javitas miatt mi romlik el. ezt kuszobold ki valahogy! de biztosra!"
//
// What breaks is never the folder list itself -- it is the NAMES. A mailbox name
// is a contract between three places that are edited by different people at
// different times:
//
//   1. the direct IMAP path (this file's subject) produces them,
//   2. the frontend pins the system folders by matching them exactly
//      (EMAIL_SYSTEM_MAILBOX_ORDER in web/app.js),
//   3. every read/move/flag call sends the same string back, and the himalaya
//      fallback has to accept it.
//
// Nothing about that is visible to a type checker: the last regression returned
// a perfectly valid list of perfectly real folders ("Kuka" instead of
// "[Gmail]/Kuka"), so every system folder silently fell through to the
// custom-label bucket and the column became a flat alphabetical list with a raw
// "INBOX" buried in the middle.
//
// So this test reads the frontend's own list and checks the backend can produce
// every name in it. Rename a folder constant on either side without the other
// and this fails, instead of Boss finding it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { himalayaMailboxName, mapDirectMailboxes } from '../web/email-imap.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_JS = join(__dirname, '..', '..', 'web', 'app.js')

/** The system mailboxes the folder column pins, read from the frontend itself. */
function frontendSystemMailboxes(): string[] {
  const src = readFileSync(APP_JS, 'utf8')
  const sent = src.match(/const EMAIL_SENT_MAILBOX = '([^']+)'/)
  // Close on a bracket at the start of a line: the entries themselves contain
  // brackets ("[Gmail]/Kuka"), so a lazy match to the first "]" stops inside one.
  const block = src.match(/const EMAIL_SYSTEM_MAILBOX_ORDER = \[\n([\s\S]*?)\n\]/)
  expect(sent, 'EMAIL_SENT_MAILBOX not found in web/app.js').not.toBeNull()
  expect(block, 'EMAIL_SYSTEM_MAILBOX_ORDER not found in web/app.js').not.toBeNull()
  return block![1]
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => (l === 'EMAIL_SENT_MAILBOX' ? sent![1] : l.replace(/^'|'$/g, '')))
}

describe('himalayaMailboxName', () => {
  it('renders the inbox the way himalaya does, whatever case the server used', () => {
    expect(himalayaMailboxName('INBOX')).toBe('Inbox')
    expect(himalayaMailboxName('Inbox')).toBe('Inbox')
    expect(himalayaMailboxName('inbox')).toBe('Inbox')
  })

  it('keeps every other folder at its FULL path, not its leaf segment', () => {
    // The exact regression: "[Gmail]/Kuka" arrived as "Kuka".
    expect(himalayaMailboxName('[Gmail]/Kuka')).toBe('[Gmail]/Kuka')
    expect(himalayaMailboxName('Freeber/Developp/Peter Botond')).toBe('Freeber/Developp/Peter Botond')
  })
})

describe('the folder column can pin every system folder it knows about', () => {
  it('produces exactly the names the frontend pins', () => {
    const wanted = frontendSystemMailboxes()
    expect(wanted.length).toBeGreaterThan(5)
    // What the server actually reports for those folders: the inbox as INBOX,
    // everything else at its full path.
    const serverPaths = wanted.map((name) => (name === 'Inbox' ? 'INBOX' : name))
    const mapped = mapDirectMailboxes(serverPaths.map((path) => ({ path, flags: new Set<string>() })))
    expect(mapped).not.toBeNull()
    expect(mapped!.map((mb) => mb.name)).toEqual(wanted)
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

  it('uses the name for the id too, the way himalaya does', () => {
    expect(mapDirectMailboxes([inbox])).toEqual([{ id: 'Inbox', name: 'Inbox', total: null, unread: null }])
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
