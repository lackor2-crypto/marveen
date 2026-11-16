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
import { readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { explorerRoot } from './life-explorer.js'
import { isInTrash, lifeName, trashRelPath } from './life-tree.js'

export interface SignatureFile { rel: string; name: string; folder: string }
/** `refreshing`: the list came straight from the remembered paths and a walk of the tree runs in the background. */
export interface SignatureList { signatures: SignatureFile[]; truncated: boolean; refreshing?: boolean }

/** Name fragments that mark a signature picture (lower case; accents and plain spelling). */
export const SIGNATURE_TERMS = ['aláírás', 'alairas', 'alárás', 'signature', 'unterschrift', 'szignó']

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

/** The walk stops after this long and says so (`truncated`): a slow drive must not keep the owner waiting forever. */
export const SIGNATURE_BUDGET_MS = 8_000
/** A finished answer is reused for this long; "search again" in the picker asks anew. */
export const SIGNATURE_CACHE_MS = 10 * 60_000
/** An answer cut short by the budget is reused only briefly (re-opening the picker must not walk again at once). */
export const SIGNATURE_PARTIAL_CACHE_MS = 2 * 60_000
const MAX_FOLDERS = 20_000
/** The identity folder's name in both languages: a person's signature lives there, so it is searched FIRST. */
const IDENTITY_NAMES = new Set([lifeName('identity', 'hu'), lifeName('identity', 'en')].map((n) => n.toLowerCase()))

let cached: { at: number; root: string; value: SignatureList } | null = null
let running: { root: string; promise: Promise<SignatureList> } | null = null
let generation = 0 // bumped by every "forget": a walk that began in an older generation must not write its answer back

/**
 * The remembered paths (owner TG 6300: "once found, remember the path; next time hand the two signatures over at once,
 * keep searching in the background; if it was moved, follow it; if it went to the trash, find it there; if it is gone
 * from the trash too, forget it"). Stored next to the other app state so it survives a restart.
 */
const MEMORY_FILE = 'signature-memory.json'
/** The trash is looked through only this far and this long: it answers "was it thrown away?", not "list everything". */
const TRASH_BUDGET_MS = 1_500
const TRASH_MAX_FOLDERS = 500

function memoryPath(): string { return join(STORE_DIR, MEMORY_FILE) }

function readMemory(root: string): SignatureFile[] {
  try {
    const m = JSON.parse(readFileSync(memoryPath(), 'utf8')) as { root?: string; entries?: SignatureFile[] }
    if (m.root !== root || !Array.isArray(m.entries)) return []
    return m.entries.filter((e) => e && typeof e.rel === 'string' && typeof e.name === 'string').map((e) => ({ rel: e.rel, name: e.name, folder: String(e.folder ?? '') }))
  } catch { return [] }
}

function writeMemory(root: string, entries: SignatureFile[]): void {
  try {
    const tmp = memoryPath() + '.tmp'
    writeFileSync(tmp, JSON.stringify({ root, entries }))
    renameSync(tmp, memoryPath())
  } catch { /* a memory that cannot be written only costs the next call a walk */ }
}

/** For tests and for the picker's "search again". Also forgets the remembered paths. */
export function forgetSignatures(): void {
  cached = null
  running = null
  generation++
  try { if (existsSync(memoryPath())) rmSync(memoryPath(), { force: true }) } catch { /* nothing to forget */ }
}

/** Test hook: drops only the in-memory answer (what a restart does); the remembered paths on disk stay. */
export function forgetInMemoryOnly(): void { cached = null; running = null; generation++ }

/** Which of the remembered files are still where they were. One stat per entry: no tree walk. */
async function stillThere(root: string, entries: SignatureFile[]): Promise<{ alive: SignatureFile[]; lost: SignatureFile[] }> {
  const alive: SignatureFile[] = []
  const lost: SignatureFile[] = []
  for (const e of entries) {
    try { if ((await stat(join(root, e.rel))).isFile()) { alive.push(e); continue } } catch { /* not there any more */ }
    lost.push(e)
  }
  return { alive, lost }
}

/** The lost ones, looked for by name in the trash (a thrown-away signature still counts until it is emptied from there). */
async function findInTrash(root: string, lost: SignatureFile[], lang: string | undefined): Promise<SignatureFile[]> {
  if (!lost.length) return []
  const wanted = new Set(lost.map((e) => e.name.toLowerCase()))
  const out: SignatureFile[] = []
  const started = Date.now()
  const trash = trashRelPath(lang)
  const queue: Array<{ abs: string; rel: string }> = [{ abs: join(root, trash), rel: trash }]
  let folders = 0
  while (queue.length && out.length < wanted.size) {
    if (Date.now() - started > TRASH_BUDGET_MS || folders >= TRASH_MAX_FOLDERS) break
    const dir = queue.shift()!
    folders++
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir.abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const name = String(e.name)
      const rel = `${dir.rel}/${name}`
      if (e.isDirectory()) { queue.push({ abs: join(dir.abs, name), rel }); continue }
      if (e.isFile() && wanted.has(name.toLowerCase())) out.push({ rel, name, folder: dir.rel })
    }
  }
  return out
}

function mergeByRel(...lists: SignatureFile[][]): SignatureFile[] {
  const seen = new Map<string, SignatureFile>()
  for (const l of lists) for (const e of l) if (!seen.has(e.rel)) seen.set(e.rel, e)
  return [...seen.values()].sort((a, b) => a.folder.localeCompare(b.folder, 'hu') || a.name.localeCompare(b.name, 'hu'))
}

async function walk(root: string, lang: string | undefined, budgetMs: number, maxFolders: number): Promise<SignatureList> {
  const started = Date.now()
  const found: SignatureFile[] = []
  let truncated = false
  // Breadth first: the folders near the top (a person's identity folder) are reached before the deep archives.
  // Breadth first alone is not enough (2026-10-11, measured on a probe tree): a wide archive that happens to be listed
  // before the person's folder fills the whole folder budget on ITS level, and the identity folder, one level further
  // down, is never reached -- "no signature" again, with the truncated note. So an identity folder, and everything
  // under it, goes to the `hot` queue, which is always served before the rest.
  const hot: Array<{ abs: string; rel: string; hot: boolean }> = []
  const queue: Array<{ abs: string; rel: string; hot: boolean }> = [{ abs: root, rel: '', hot: false }]
  let folders = 0
  while (hot.length || queue.length) {
    if (Date.now() - started > budgetMs || folders >= maxFolders) { truncated = true; break }
    const dir = hot.length ? hot.shift()! : queue.shift()!
    folders++
    // One read per folder, with the entry types: no stat per file. `await` hands the event loop back every time.
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir.abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const name = String(e.name)
      if (name.startsWith('.')) continue
      const rel = dir.rel ? `${dir.rel}/${name}` : name
      if (e.isDirectory()) {
        if (isInTrash(rel, lang)) continue
        const isHot = dir.hot || IDENTITY_NAMES.has(name.toLowerCase())
        ;(isHot ? hot : queue).push({ abs: join(dir.abs, name), rel, hot: isHot })
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
export async function listSignatures(lang?: string, opts?: { fresh?: boolean; budgetMs?: number; maxFolders?: number }): Promise<SignatureList> {
  const root = explorerRoot()
  if (!root) return { signatures: [], truncated: false }
  const now = Date.now()
  if (!opts?.fresh && cached && cached.root === root && now - cached.at < (cached.value.truncated ? SIGNATURE_PARTIAL_CACHE_MS : SIGNATURE_CACHE_MS)) {
    // A reused answer is only as good as the files it names: one stat each (no walk). If the owner moved or trashed a
    // picture since (browser-measured, #919: the picker still showed the OLD place for the next ten minutes), the
    // answer is dropped and the remembered paths below follow the move / the trash instead.
    const { lost } = await stillThere(root, cached.value.signatures)
    if (!lost.length) return cached.value
    cached = null
  }
  if (running && running.root === root) return running.promise
  const budgetMs = opts?.budgetMs ?? SIGNATURE_BUDGET_MS
  const maxFolders = opts?.maxFolders ?? MAX_FOLDERS
  const remembered = opts?.fresh ? [] : readMemory(root)
  const startWalk = (): Promise<SignatureList> => {
    const startedIn = generation
    const promise = walk(root, lang, budgetMs, maxFolders)
      .then(async (value) => {
        // A complete walk replaces the memory; one cut short only ADDS to it (what it did not reach is not "gone").
        const old = readMemory(root)
        const { alive, lost } = await stillThere(root, old)
        const inTrash = await findInTrash(root, lost.filter((e) => !value.signatures.some((s) => s.name.toLowerCase() === e.name.toLowerCase())), lang)
        const kept = value.truncated ? mergeByRel(alive, value.signatures, inTrash) : mergeByRel(value.signatures, inTrash)
        // Forgotten while it ran ("search again", a restart): its answer is stale, it must not overwrite what came since.
        if (startedIn !== generation) return { signatures: kept, truncated: value.truncated }
        writeMemory(root, kept)
        // What is reused for the next ten minutes is what is remembered (a trashed signature included), not the bare walk.
        const merged: SignatureList = { signatures: kept, truncated: value.truncated }
        cached = { at: Date.now(), root, value: merged }
        return merged
      })
      .finally(() => { if (running && running.promise === promise) running = null })
    running = { root, promise }
    return promise
  }
  if (remembered.length) {
    // Remembered paths: answer at once from them (a stat each), follow a move or a trash, and let the walk run behind.
    const { alive, lost } = await stillThere(root, remembered)
    const inTrash = await findInTrash(root, lost, lang)
    const quick = mergeByRel(alive, inTrash)
    if (quick.length) {
      startWalk().catch(() => { /* the background look is best effort */ })
      return { signatures: quick, truncated: false, refreshing: true }
    }
    // Everything remembered is gone, also from the trash: forget it and look anew.
    writeMemory(root, [])
  }
  return startWalk()
}
