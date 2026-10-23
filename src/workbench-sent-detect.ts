// AUTOMATIC "WAS IT SENT?" FROM THE SENT MAILBOX (#741, Boss TG 4131/4135).
//
// Boss: "the system should watch the Sent folder of the address I entered as the sender; if the attachment is in there,
// it was sent -- a changed subject must not matter". So a document counts as sent when a message in the Sent mailbox of
// the sender account carries an attachment with the name of one of the document's generated files.
//
// The mail client lives in the e-mail routes; they register a port here (like workbench-maildraft.ts does), so this
// module stays free of the mail client. Best effort and silent: a mail server that does not answer leaves the document
// "not sent", exactly as before -- the owner can still mark it by hand.
//
// #750: the sending goes on the final whose file the mail CARRIED (a document can have several finals; the newest one is
// not necessarily the one that was attached). A mail that only matches a name of the stored mail draft cannot say which
// final it was, so it gets the plain by-hand mark and no version.

import { basename } from 'node:path'
import { getDb } from './db.js'
import { listFinals, finalState } from './workbench-docfinal.js'
import { markSentManually, recordSent, sentStatus, sentVersionIds } from './workbench-docsent.js'
import { getWorkItem } from './workbench.js'

export interface SentMailInfo { id: string; date: string; to: string; messageId: string; attachments: string[] }
export interface SentMailPort {
  /** The ids of the mail accounts that can be looked into. */
  accounts(): string[]
  /** The newest messages of the account's Sent mailbox that carry attachments (names read), newest first. */
  recent(account: string, limit: number, sinceMs: number): Promise<SentMailInfo[]>
}
let port: SentMailPort | null = null
export function registerSentMailPort(p: SentMailPort): void { port = p }

const MAX_MESSAGES = 8
/** A look that found nothing is not repeated for a minute: the move list is opened again and again. */
const MISS_TTL_MS = 60_000
const misses = new Map<string, number>()

/** A file name compared the way a person would: case, spaces and a " (2)" copy mark anywhere ("X (2) - végleges.pdf") do not matter. */
export function normName(n: string): string {
  return basename(String(n || '')).toLowerCase().normalize('NFC').replace(/\s*\(\d+\)/g, '').replace(/\s+/g, ' ').trim()
}

/** A final of the document and the names of the files it made (the final PDF and its parts). */
export interface FinalNames { version_id: string; created_at: number; names: Set<string> }

/** The names of the files each final made, and every attachment of the stored mail draft (which belongs to no one final). */
export function sentCandidateNames(itemId: string): { finals: FinalNames[]; draftNames: Set<string>; since: number; account: string } {
  const finals: FinalNames[] = []
  const draftNames = new Set<string>()
  let since = 0
  for (const f of listFinals(itemId)) {
    const names = new Set<string>()
    for (const n of [f.pdf_name, basename(f.pdf_path || ''), ...(f.files || []).flatMap((x) => [x.name, basename(x.path || '')])]) if (n) names.add(normName(n))
    finals.push({ version_id: f.version_id, created_at: f.created_at, names })
    since = since ? Math.min(since, f.created_at) : f.created_at
  }
  let account = ''
  try {
    const row = getDb().prepare('SELECT from_account AS a, attachments_json AS j, updated_at AS u FROM wb_doc_maildraft WHERE work_item_id = ?').get(itemId) as { a: string; j: string; u: number } | undefined
    if (row) {
      account = row.a || ''
      try { for (const a of JSON.parse(row.j || '[]') as { name?: string }[]) if (a?.name) draftNames.add(normName(a.name)) } catch { /* bad JSON: no draft names */ }
    }
  } catch { /* the draft table does not exist yet: no draft */ }
  return { finals, draftNames, since, account }
}

/**
 * The finals whose files a mail carried. Two finals that made a file of the same name cannot be told apart by the name:
 * then the newest one that already existed when the mail went out (a final made later cannot be in it), else the oldest.
 */
export function finalsCarriedBy(finals: FinalNames[], attachments: string[], mailDate: string): string[] {
  const t = Date.parse(mailDate)
  const out = new Set<string>()
  for (const a of new Set(attachments.map(normName))) {
    const same = finals.filter((f) => f.names.has(a)).sort((x, y) => y.created_at - x.created_at)
    if (!same.length) continue
    const before = Number.isFinite(t) ? same.find((f) => f.created_at <= t / 1000 + 86_400) : undefined
    out.add((before ?? same[same.length - 1]).version_id)
  }
  return [...out]
}

/**
 * For each given document that is not marked sent yet: look into the Sent mailbox (the draft's sender account, else every
 * account) and record the sending of every final whose file a mail carried. Returns the ids that were found sent.
 */
export async function detectSentByMail(itemIds: string[]): Promise<string[]> {
  if (!port) return []
  const found: string[] = []
  for (const id of itemIds) {
    if (!id || sentStatus(id).sent) continue
    const { finals, draftNames, since, account } = sentCandidateNames(id)
    const names = new Set<string>([...draftNames, ...finals.flatMap((f) => [...f.names])])
    if (!names.size) continue
    if ((misses.get(id) || 0) > Date.now()) continue
    const accounts = account ? [account] : port.accounts()
    const hits: { info: SentMailInfo; account: string }[] = []
    for (const acc of accounts) {
      let msgs: SentMailInfo[] = []
      try { msgs = await port.recent(acc, MAX_MESSAGES, since ? (since - 86_400) * 1000 : 0) } catch { continue }
      for (const m of msgs) {
        // A mail older than the first finalisation cannot be this document's sending (one day of slack for clock skew).
        const t = Date.parse(m.date)
        if (since && Number.isFinite(t) && t / 1000 < since - 86_400) continue
        if (m.attachments.some((a) => names.has(normName(a)))) hits.push({ info: m, account: acc })
      }
    }
    if (!hits.length) { misses.set(id, Date.now() + MISS_TTL_MS); continue }
    const item = getWorkItem(id)
    // The sendings found, the newest mail first; a final that was sent in several mails is recorded once.
    const done = sentVersionIds(id)
    let ok = false
    for (const hit of hits) {
      const day = /^\d{4}-\d{2}-\d{2}/.exec(hit.info.date)?.[0] || new Date().toISOString().slice(0, 10)
      const to = hit.info.to || hit.account
      for (const versionId of finalsCarriedBy(finals, hit.info.attachments, hit.info.date)) {
        if (!item || done.has(versionId)) continue
        if (recordSent(item, { date: day, recipient: to, method: 'email', reference: hit.info.messageId, note: 'found in the Sent mailbox' }, 'sent-mailbox', versionId).ok) { done.add(versionId); ok = true }
      }
    }
    // No final to hang the sending on (the mail carried a draft attachment only, or an old document): the same honest
    // mark the owner would click -- it claims no version.
    if (!ok) { markSentManually(id, 'sent-mailbox'); ok = true }
    if (ok) found.push(id)
  }
  return found
}
