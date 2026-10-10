// Saved signatures (Boss TG 3040/3044): picture files anywhere in the Life tree
// whose name says they are a signature. The document editor lists them and the
// owner picks which one goes onto the page; nothing is copied or moved.
//
// 2026-10-10 (owner: "it finds no signature, though it is there in the identity folder"; measured: the request did
// not answer in 90 s and the whole dashboard stood still, a restart had to SIGKILL the process): the list used to be
// built by SIX synchronous full walks of the Life tree (searchLife once per name fragment, a stat per entry), on a
// drive where one walk takes minutes. A synchronous walk inside a request handler freezes every other request too.
// So this is now ONE asynchronous walk for all fragments, reading each folder once (no stat per entry), with a time
// budget, an answer that is remembered, and one walk shared by everyone who asks at the same time.
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { explorerRoot } from './life-explorer.js'
import { isInTrash } from './life-tree.js'

export interface SignatureFile { rel: string; name: string; folder: string }
export interface SignatureList { signatures: SignatureFile[]; truncated: boolean }

/** Name fragments that mark a signature picture (lower case; accents and plain spelling). */
export const SIGNATURE_TERMS = ['aláírás', 'alairas', 'alárás', 'signature', 'unterschrift', 'szignó']

const IMAGE_EXT = /\.(png|jpe?g|gif)$/i

/** The walk stops after this long and says so (`truncated`): a slow drive must not keep the owner waiting forever. */
export const SIGNATURE_BUDGET_MS = 8_000
/** A finished answer is reused for this long; "search again" in the picker asks anew. */
export const SIGNATURE_CACHE_MS = 10 * 60_000
/** An answer cut short by the budget is reused only briefly (re-opening the picker must not walk again at once). */
export const SIGNATURE_PARTIAL_CACHE_MS = 2 * 60_000
const MAX_FOLDERS = 20_000

let cached: { at: number; root: string; value: SignatureList } | null = null
let running: { root: string; promise: Promise<SignatureList> } | null = null

/** For tests and for the picker's "search again". */
export function forgetSignatures(): void { cached = null }

async function walk(root: string, lang: string | undefined, budgetMs: number): Promise<SignatureList> {
  const started = Date.now()
  const found: SignatureFile[] = []
  let truncated = false
  // Breadth first: the folders near the top (a person's identity folder) are reached before the deep archives.
  const queue: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  let folders = 0
  while (queue.length) {
    if (Date.now() - started > budgetMs || folders >= MAX_FOLDERS) { truncated = true; break }
    const dir = queue.shift()!
    folders++
    // One read per folder, with the entry types: no stat per file. `await` hands the event loop back every time.
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir.abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const name = String(e.name)
      if (name.startsWith('.')) continue
      const rel = dir.rel ? `${dir.rel}/${name}` : name
      if (e.isDirectory()) {
        if (!isInTrash(rel, lang)) queue.push({ abs: join(dir.abs, name), rel })
        continue
      }
      if (!e.isFile() || !IMAGE_EXT.test(name)) continue
      const low = name.toLowerCase()
      if (SIGNATURE_TERMS.some((t) => low.includes(t))) found.push({ rel, name, folder: dir.rel })
    }
  }
  const signatures = found.sort((a, b) => a.folder.localeCompare(b.folder, 'hu') || a.name.localeCompare(b.name, 'hu'))
  return { signatures, truncated }
}

/**
 * The signature pictures of the Life tree. Never blocks the server: the walk is asynchronous.
 * `truncated`: the time budget ran out before the whole tree was seen -- what was found so far is returned (the
 * walk is breadth first, so the folders near the top were seen), and the caller must SAY that it is not the whole
 * tree: an empty truncated list means "I did not get to the end", not "there is none".
 */
export async function listSignatures(lang?: string, opts?: { fresh?: boolean; budgetMs?: number }): Promise<SignatureList> {
  const root = explorerRoot()
  if (!root) return { signatures: [], truncated: false }
  const now = Date.now()
  if (!opts?.fresh && cached && cached.root === root && now - cached.at < (cached.value.truncated ? SIGNATURE_PARTIAL_CACHE_MS : SIGNATURE_CACHE_MS)) return cached.value
  if (running && running.root === root) return running.promise
  const promise = walk(root, lang, opts?.budgetMs ?? SIGNATURE_BUDGET_MS)
    .then((value) => { cached = { at: Date.now(), root, value }; return value })
    .finally(() => { if (running && running.promise === promise) running = null })
  running = { root, promise }
  return promise
}
