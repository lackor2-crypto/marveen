// Saving a workbench e-mail draft into the Drafts folder of an Iroda mail account (#725 / #726).
//
// Boss TG 4003: the first press of the draft button did not put the draft into the Drafts folder, the second did. Both steps
// of a save can fail for a moment and succeed a second later:
//   1. finding the Drafts folder's name (the direct IMAP login can fail while it is cold or the provider throttles) -- a failed
//      lookup used to fall silently to a guessed name, which is wrong on every account that is not a Hungarian Gmail;
//   2. the himalaya `compose --save` call ("Resource temporarily unavailable (os error 11)").
// Both are retried here, and a final failure is logged with the real error text, so the next report has evidence.
// Kept free of the mail client so the order of the steps is unit-tested (the route passes the real calls in).

import { composeArgs } from '../mail-send.js'

export interface DraftMessage { to: string; cc: string; subject: string; body: string; files: string[] }

export interface DraftSaveDeps {
  isKnownAccount(id: string): boolean
  accountEmail(id: string): string
  /** The account's own special folder names; null = the lookup itself failed right now (worth a retry), an object is final. */
  resolveFolders(id: string): Promise<{ drafts?: string } | null>
  /** Used only when the account has no flagged Drafts folder, or the lookup kept failing. */
  fallbackFolder: string
  /** Runs `himalaya message compose ... --save <folder>` (with its own retry of the transient error). */
  compose(args: string[]): Promise<{ ok: boolean; text: string }>
  onSaved(id: string, folder: string): void
  warn(text: string): void
  sleep?(ms: number): Promise<void>
}

export type DraftSaveResult = { ok: boolean; mailbox?: string; detail?: string }

export const FOLDER_LOOKUP_ATTEMPTS = 3
const FOLDER_LOOKUP_BASE_MS = 400

export async function saveDraftToFolder(deps: DraftSaveDeps, accountId: string, m: DraftMessage): Promise<DraftSaveResult> {
  if (!deps.isKnownAccount(accountId)) return { ok: false, detail: 'unknown account' }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let drafts: string | undefined
  let looked = false
  for (let i = 0; i < FOLDER_LOOKUP_ATTEMPTS; i++) {
    let found: { drafts?: string } | null = null
    try { found = await deps.resolveFolders(accountId) } catch { found = null }
    if (found) { drafts = found.drafts; looked = true; break }
    if (i < FOLDER_LOOKUP_ATTEMPTS - 1) await sleep(FOLDER_LOOKUP_BASE_MS * 2 ** i)
  }
  if (!drafts) {
    drafts = deps.fallbackFolder
    deps.warn(`[email] draft save: the Drafts folder of "${accountId}" ${looked ? 'is not flagged' : 'could not be looked up'}; fallback "${drafts}"`)
  }

  // #797: the compose arguments come from the shared sender, the one place they are built.
  const args = composeArgs(accountId, deps.accountEmail(accountId), { to: m.to, cc: m.cc, subject: m.subject, body: m.body, attachments: m.files }, { send: false, saveTo: drafts })
  const r = await deps.compose(args)
  if (!r.ok) {
    deps.warn(`[email] draft save into "${drafts}" failed for "${accountId}": ${r.text}`)
    return { ok: false, detail: r.text }
  }
  deps.onSaved(accountId, drafts)
  return { ok: true, mailbox: drafts }
}
