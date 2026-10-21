// AUTOMATIC "WAS IT SENT?" FROM THE SENT MAILBOX (#741, Boss TG 4131/4135).
//
// Boss: "the system should watch the Sent folder of the address I entered as the sender; if the attachment is in there,
// it was sent -- a changed subject must not matter". So a document counts as sent when a message in the Sent mailbox of
// the sender account carries an attachment with the name of one of the document's generated files.
//
// The mail client lives in the e-mail routes; they register a port here (like workbench-maildraft.ts does), so this
// module stays free of the mail client. Best effort and silent: a mail server that does not answer leaves the document
// "not sent", exactly as before -- the owner can still mark it by hand.

import { basename } from 'node:path'
import { getDb } from './db.js'
import { listFinals, finalState } from './workbench-docfinal.js'
import { markSentManually, recordSent, sentStatus } from './workbench-docsent.js'
import { getWorkItem } from './workbench.js'

export interface SentMailInfo { id: string; date: string; to: string; messageId: string; attachments: string[] }
export interface SentMailPort {
  /** The ids of the mail accounts that can be looked into. */
  accounts(): string[]
  /** The newest messages of the account's Sent mailbox that carry attachments (names read), newest first. */
  recent(account: string, limit: number): Promise<SentMailInfo[]>
}
let port: SentMailPort | null = null
export function registerSentMailPort(p: SentMailPort): void { port = p }

const MAX_MESSAGES = 8

/** A file name compared the way a person would: case, spaces and a " (2)" copy mark anywhere ("X (2) - végleges.pdf") do not matter. */
export function normName(n: string): string {
  return basename(String(n || '')).toLowerCase().normalize('NFC').replace(/\s*\(\d+\)/g, '').replace(/\s+/g, ' ').trim()
}

/** The names of every file the document made (final PDFs and their parts) and every attachment of its stored mail draft. */
export function sentCandidateNames(itemId: string): { names: Set<string>; since: number; account: string } {
  const names = new Set<string>()
  let since = 0
  for (const f of listFinals(itemId)) {
    for (const n of [f.pdf_name, basename(f.pdf_path || ''), ...(f.files || []).flatMap((x) => [x.name, basename(x.path || '')])]) if (n) names.add(normName(n))
    since = since ? Math.min(since, f.created_at) : f.created_at
  }
  let account = ''
  try {
    const row = getDb().prepare('SELECT from_account AS a, attachments_json AS j, updated_at AS u FROM wb_doc_maildraft WHERE work_item_id = ?').get(itemId) as { a: string; j: string; u: number } | undefined
    if (row) {
      account = row.a || ''
      try { for (const a of JSON.parse(row.j || '[]') as { name?: string }[]) if (a?.name) names.add(normName(a.name)) } catch { /* bad JSON: no draft names */ }
    }
  } catch { /* the draft table does not exist yet: no draft */ }
  return { names, since, account }
}

/**
 * For each given document that is not marked sent yet: look into the Sent mailbox (the draft's sender account, else every
 * account) and record the sending when an attachment name matches. Returns the ids that were found sent.
 */
export async function detectSentByMail(itemIds: string[]): Promise<string[]> {
  if (!port) return []
  const found: string[] = []
  for (const id of itemIds) {
    if (!id || sentStatus(id).sent) continue
    const { names, since, account } = sentCandidateNames(id)
    if (!names.size) continue
    const accounts = account ? [account] : port.accounts()
    let hit: { info: SentMailInfo; account: string } | null = null
    for (const acc of accounts) {
      let msgs: SentMailInfo[] = []
      try { msgs = await port.recent(acc, MAX_MESSAGES) } catch { continue }
      for (const m of msgs) {
        // A mail older than the first finalisation cannot be this document's sending (one day of slack for clock skew).
        const t = Date.parse(m.date)
        if (since && Number.isFinite(t) && t / 1000 < since - 86_400) continue
        if (m.attachments.some((a) => names.has(normName(a)))) { hit = { info: m, account: acc }; break }
      }
      if (hit) break
    }
    if (!hit) continue
    const item = getWorkItem(id)
    const day = /^\d{4}-\d{2}-\d{2}/.exec(hit.info.date)?.[0] || new Date().toISOString().slice(0, 10)
    const to = hit.info.to || hit.account
    let ok = false
    if (item && finalState(item) && !finalState(item)!.stale) {
      ok = recordSent(item, { date: day, recipient: to, method: 'email', reference: hit.info.messageId, note: 'found in the Sent mailbox' }, 'sent-mailbox').ok
    }
    // No current final to hang the sending on (an old document): the same honest mark the owner would click.
    if (!ok) { markSentManually(id, 'sent-mailbox'); ok = true }
    if (ok) found.push(id)
  }
  return found
}
