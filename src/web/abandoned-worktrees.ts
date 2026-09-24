// ABANDONED WORKTREES -- every agent sees ITS OWN half-finished worktrees when
// it wakes up, and finishes them first (kanban 722896e9, #366).
//
// The owner, 2026-09-24: "keszitsd fel a Marvint, hogy tudja az osszes agent,
// hogy hol jart, milyen munkaba. Es azt utana, feleledes utan, azonnal rogton
// csinalja is meg. Ezt egesd be a Marvinba."
//
// What was measured that day: 85 git worktrees, 8 of them with uncommitted
// edits that sat there for days (the oldest since 2026-08-23). Nothing said a
// word, because:
//   - the uncommitted-work watcher only reads the LIVE checkout (PROJECT_ROOT),
//   - the SessionStart "pending work" block only lists kanban cards and hot
//     memories -- an agent that ran out of quota mid-edit woke up with no idea
//     that a worktree full of its own edits was waiting,
//   - `land-pr.sh` squash-merges, so a landed branch still looks "1 commit
//     ahead" of main: ancestry cannot tell landed from not-landed, and a list
//     built from ancestry would drown the real cases in ~30 false ones.
//
// So this module answers three questions per worktree, each from the source:
//   1. Is anything uncommitted?   `git status --porcelain`
//   2. Is it already on main?     which share of the ADDED lines (uncommitted,
//      and merge-base..HEAD) already stands in the `origin/main` version of the
//      same file -- content, not ancestry (see LANDED_PCT for the measurement).
//   3. Whose is it?               the agent audit log (store/agent-audit.jsonl):
//      the last KNOWN agent that edited/wrote a file inside it. No guessing from
//      the folder name. Nobody known -> "gazdatlan", and the main agent (the
//      coordinator) gets it, but only once it has been quiet for a while, so a
//      live side-session working in it is not stepped on.
//
// Read-only: it never commits, removes or cleans anything. Deleting a worktree
// is a deletion and stays behind the owner's yes (the ask-back rule).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const MAX_LISTED = 8
export const MAX_FILES_SHOWN = 4
/** An unowned worktree is handed to the main agent only after this much quiet:
 *  a younger one may still be under a live side-session's hands. */
export const UNOWNED_QUIET_MS = 3 * 60 * 60_000

export interface WorktreeRef { path: string; branch: string | null }

export type WorktreeState =
  | { kind: 'clean' } // nothing uncommitted, nothing unlanded -> silent
  | {
      kind: 'pending'
      dirtyFiles: string[]
      /** % of the uncommitted ADDED lines that already exist on origin/main (null: nothing uncommitted). */
      dirtyOnMainPct: number | null
      /** Commits whose change is NOT (yet) on origin/main; 0 = none, or landed. */
      unlandedCommits: number
      /** % of the committed ADDED lines already on origin/main (null: no commits ahead). */
      commitsOnMainPct: number | null
      lastChangeMs: number
    }

/** At or above this share of its added lines on main, a branch counts as
 *  landed. Measured 2026-09-24 over 35 worktrees: landed ones 92-100%
 *  (squash-merged, some touched again later), never-landed ones 0-22%. */
export const LANDED_PCT = 90

export interface AbandonedWorktree extends WorktreeRef {
  owner: string | null
  state: Extract<WorktreeState, { kind: 'pending' }>
}

export interface AbandonedResult {
  items: AbandonedWorktree[]
  /** Worktrees without a known owner, listed for the main agent. */
  unowned: AbandonedWorktree[]
  /** We could not look (git or the audit log failed). NOT "nothing abandoned". */
  olvashatatlan: boolean
}

/** `git worktree list --porcelain` -> worktrees, the main checkout and bare entries left out. */
export function parseWorktreeList(porcelain: string, mainRoot: string): WorktreeRef[] {
  const out: WorktreeRef[] = []
  const main = resolve(mainRoot)
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const wt = lines.find((l) => l.startsWith('worktree '))
    if (!wt || lines.some((l) => l === 'bare')) continue
    const path = wt.slice('worktree '.length).trim()
    if (resolve(path) === main) continue
    const br = lines.find((l) => l.startsWith('branch '))
    out.push({ path, branch: br ? br.slice('branch '.length).replace(/^refs\/heads\//, '').trim() : null })
  }
  return out
}

const FILE_OPS = new Set(['edit', 'write', 'delete', 'move'])

/**
 * Owner of each worktree from the audit log: the LAST line, by a known agent,
 * that changed a file inside it (or ran with its cwd inside it). The log is
 * append-only, so "last" is the latest. Read-only commands that merely mention
 * a path (grep, ls) do not count: only file operations and the cwd do.
 */
export function attributeOwners(auditText: string, paths: string[], knownAgents: string[]): Map<string, string | null> {
  const known = new Set(knownAgents)
  const owners = new Map<string, string | null>(paths.map((p) => [p, null]))
  const prefixes = paths.map((p) => [p, p.replace(/\/+$/, '') + '/'] as const)
  for (const line of auditText.split('\n')) {
    if (!line.includes('/')) continue
    let rec: { agent?: string; op?: string; target?: string; cwd?: string }
    try { rec = JSON.parse(line) } catch { continue }
    if (!rec.agent || !known.has(rec.agent)) continue
    for (const [p, pre] of prefixes) {
      const hitFile = FILE_OPS.has(rec.op ?? '') && typeof rec.target === 'string' && rec.target.startsWith(pre)
      const hitCwd = typeof rec.cwd === 'string' && (rec.cwd === p || rec.cwd.startsWith(pre))
      if (hitFile || hitCwd) owners.set(p, rec.agent)
    }
  }
  return owners
}

/** `git status --porcelain` -> the paths (rename: the new one). */
export function parseDirtyFiles(porcelain: string): string[] {
  const files: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue
    let p = line.slice(3)
    const arrow = p.indexOf(' -> ')
    if (arrow >= 0) p = p.slice(arrow + 4)
    files.push(p.replace(/^"|"$/g, ''))
  }
  return files
}

export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>

export const defaultGit: GitRun = (cwd, args) =>
  new Promise((res) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      res({ ok: !err, out: String(stdout ?? '') })
    })
  })

/** `git diff -U0` -> the added, non-blank lines per file. */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let file: string | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      file = p === '/dev/null' ? null : p.replace(/^b\//, '')
      if (file && !out.has(file)) out.set(file, [])
      continue
    }
    if (file && line.startsWith('+') && line.slice(1).trim() !== '') out.get(file)!.push(line.slice(1).trim())
  }
  return out
}

/**
 * Which share of `added` lines already stands in the `base` version of each
 * file. Content, not ancestry: land-pr squash-merges, so a landed branch is
 * never an ancestor of main, and main may have edited the same file since.
 * No added lines at all (a pure deletion) -> 100 when the files are gone on
 * base too, else 0.
 */
export async function onBasePct(path: string, base: string, added: Map<string, string[]>, deleted: string[], git: GitRun): Promise<number> {
  let tot = 0
  let hit = 0
  for (const [file, lines] of added) {
    if (!lines.length) continue
    const b = await git(path, ['show', `${base}:${file}`])
    const have = new Set(b.ok ? b.out.split('\n').map((l) => l.trim()) : [])
    for (const l of lines) { tot++; if (have.has(l)) hit++ }
  }
  if (tot > 0) return Math.floor((100 * hit) / tot)
  for (const f of deleted) {
    if ((await git(path, ['rev-parse', '--verify', '--quiet', `${base}:${f}`])).ok) return 0
  }
  return 100
}

/**
 * The state of one worktree against `base` (normally origin/main). Throws only
 * when git itself cannot answer the status question -- the caller turns that
 * into `olvashatatlan`, never into "clean".
 */
export async function worktreeState(path: string, base: string, git: GitRun = defaultGit): Promise<WorktreeState> {
  // A worktree whose folder is gone ("prunable") holds no work to finish.
  if (!existsSync(path)) return { kind: 'clean' }
  const st = await git(path, ['status', '--porcelain', '--untracked-files=all'])
  if (!st.ok) throw new Error(`git status failed in ${path}`)
  // The node_modules symlink agent-worktree.sh makes is not work.
  const dirtyFiles = parseDirtyFiles(st.out).filter((f) => f !== 'node_modules' && !f.startsWith('node_modules/'))

  let lastChangeMs = 0
  let dirtyOnMainPct: number | null = null
  if (dirtyFiles.length) {
    const tracked = await git(path, ['diff', '-U0', 'HEAD'])
    const added = addedLinesByFile(tracked.out)
    const deleted: string[] = []
    for (const f of dirtyFiles) {
      const abs = join(path, f)
      if (!existsSync(abs)) { deleted.push(f); continue }
      try { lastChangeMs = Math.max(lastChangeMs, statSync(abs).mtimeMs) } catch { /* gone meanwhile */ }
      if (!added.has(f)) {
        // Untracked: every line is new.
        try {
          added.set(f, readFileSync(abs, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))
        } catch { added.set(f, []) }
      }
    }
    dirtyOnMainPct = await onBasePct(path, base, added, deleted, git)
  }

  let unlandedCommits = 0
  let commitsOnMainPct: number | null = null
  const mb = await git(path, ['merge-base', 'HEAD', base])
  const head = await git(path, ['rev-parse', 'HEAD'])
  if (mb.ok && head.ok && mb.out.trim() !== head.out.trim()) {
    const m = mb.out.trim()
    const count = await git(path, ['rev-list', '--count', `${m}..HEAD`])
    const diff = await git(path, ['diff', '-U0', m, 'HEAD'])
    const gone = await git(path, ['diff', '--name-only', '--diff-filter=D', m, 'HEAD'])
    commitsOnMainPct = await onBasePct(path, base, addedLinesByFile(diff.out), gone.out.split('\n').filter(Boolean), git)
    if (commitsOnMainPct < LANDED_PCT) unlandedCommits = Number.parseInt(count.out.trim(), 10) || 1
    const ct = await git(path, ['log', '-1', '--format=%ct', 'HEAD'])
    lastChangeMs = Math.max(lastChangeMs, (Number.parseInt(ct.out.trim(), 10) || 0) * 1000)
  }

  if (dirtyFiles.length === 0 && unlandedCommits === 0) return { kind: 'clean' }
  return { kind: 'pending', dirtyFiles, dirtyOnMainPct, unlandedCommits, commitsOnMainPct, lastChangeMs }
}

export interface AbandonedDeps {
  listWorktrees: () => Promise<WorktreeRef[]>
  readAudit: () => string
  knownAgents: () => string[]
  state: (path: string) => Promise<WorktreeState>
  now: () => number
}

/**
 * The abandoned worktrees of `agent`. For the main agent the unowned ones are
 * added (after UNOWNED_QUIET_MS of quiet). Never throws.
 */
export async function getAbandonedWorktrees(agent: string, mainAgentId: string, deps: AbandonedDeps): Promise<AbandonedResult> {
  try {
    const wts = await deps.listWorktrees()
    const owners = attributeOwners(deps.readAudit(), wts.map((w) => w.path), deps.knownAgents())
    const isMain = agent === mainAgentId
    const mine = wts.filter((w) => owners.get(w.path) === agent)
    const nobody = isMain ? wts.filter((w) => owners.get(w.path) == null) : []
    const items: AbandonedWorktree[] = []
    const unowned: AbandonedWorktree[] = []
    // In parallel: the main agent may look at dozens, and the SessionStart hook
    // waits for this answer.
    // One worktree git cannot read must not blind the rest: it is counted as
    // "could not look", the others are still listed.
    let failed = 0
    const states = await Promise.all([...mine, ...nobody].map((w) => deps.state(w.path).catch(() => { failed++; return null })))
    ;[...mine, ...nobody].forEach((w, i) => {
      const s = states[i]
      if (!s || s.kind !== 'pending') return
      if (i < mine.length) items.push({ ...w, owner: agent, state: s })
      else if (deps.now() - s.lastChangeMs >= UNOWNED_QUIET_MS) unowned.push({ ...w, owner: null, state: s })
    })
    const byAge = (a: AbandonedWorktree, b: AbandonedWorktree) => b.state.lastChangeMs - a.state.lastChangeMs
    return { items: items.sort(byAge), unowned: unowned.sort(byAge), olvashatatlan: failed > 0 }
  } catch {
    return { items: [], unowned: [], olvashatatlan: true }
  }
}

function describe(w: AbandonedWorktree): string {
  const s = w.state
  const bits: string[] = []
  if (s.dirtyFiles.length) {
    const shown = s.dirtyFiles.slice(0, MAX_FILES_SHOWN).join(', ')
    const more = s.dirtyFiles.length > MAX_FILES_SHOWN ? ` +${s.dirtyFiles.length - MAX_FILES_SHOWN}` : ''
    const pct = s.dirtyOnMainPct != null && s.dirtyOnMainPct >= LANDED_PCT
      ? ` -- a sorok ${s.dirtyOnMainPct}%-a MAR A MAINEN: valoszinuleg maradek`
      : s.dirtyOnMainPct != null ? ` -- a sorok ${s.dirtyOnMainPct}%-a van a mainen` : ''
    bits.push(`${s.dirtyFiles.length} commitolatlan fajl (${shown}${more})${pct}`)
  }
  if (s.unlandedCommits) bits.push(`${s.unlandedCommits} landolatlan commit (a sorai ${s.commitsOnMainPct ?? 0}%-a van a mainen)`)
  const when = s.lastChangeMs ? new Date(s.lastChangeMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '?'
  return `  - ${w.path}${w.branch ? ` [${w.branch}]` : ' [detached]'}: ${bits.join('; ')}; utolso valtozas ${when}`
}

function listBlock(title: string, list: AbandonedWorktree[]): string {
  const shown = list.slice(0, MAX_LISTED).map(describe)
  if (list.length > MAX_LISTED) shown.push(`  - ... es meg ${list.length - MAX_LISTED} (git worktree list)`)
  return `${title}\n${shown.join('\n')}`
}

/** The SessionStart text. null when there is nothing to say. */
export function buildAbandonedWorktreeContext(res: AbandonedResult): string | null {
  if (res.olvashatatlan && !res.items.length && !res.unowned.length) {
    return '=== FELBEHAGYOTT WORKTREE-K: NEM LATTAM ODA ===\n' +
      'A worktree-k allapotat most nem tudtam lekerdezni (git vagy az audit-naplo hibazott). Ez NEM azt jelenti, hogy nincs felbehagyott munkad: ' +
      'nezd meg kezzel (`git worktree list`, majd `git -C <ut> status`).'
  }
  if (!res.items.length && !res.unowned.length) return null
  const parts = ['=== FELBEHAGYOTT WORKTREE-K -- ELOSZOR EZEKET FEJEZD BE ===']
  if (res.items.length) parts.push(listBlock('A TE worktree-id, amikben commitolatlan vagy landolatlan munka all (az audit-naplo szerint te dolgoztal bennuk utoljara):', res.items))
  if (res.unowned.length) parts.push(listBlock('GAZDATLAN worktree-k (egyetlen ismert agens sem dolgozott bennuk; ezeket a fo agens viszi):', res.unowned))
  if (res.olvashatatlan) parts.push('FIGYELEM: legalabb egy worktree allapotat nem tudtam lekerdezni -- a lista lehet hianyos (`git worktree list`).')
  parts.push(
    'TEENDO MOST, minden uj munka elott (a tulajdonos, 2026-09-24: "feleledes utan azonnal csinalja is meg"):\n' +
      '  1. Nezd meg a valtozast (`git -C <ut> diff`, `git -C <ut> status`), es VIDD KESZRE: teszt, commit, `scripts/land-pr.sh "cim"` abbol a worktree-bol.\n' +
      '  2. Ha a sor szerint a tartalom MAR A MAINEN VAN (vagy a munka mas formaban mar landolt -- nezd meg a main-t), a worktree csak maradek: NE landold ujra. A torles torles -- kerdezd meg a tulajdonost a csatornadon, es csak az o igen-je utan futtasd a `scripts/agent-worktree.sh --remove <nev>`-et.\n' +
      '  3. Ha egy tetel megsem a tied, irj a gazdajanak inter-agent uzenetet -- idegen worktree-be nem irsz.\n' +
      '  4. A kesz munka kartyajat tedd "waiting"-be, es jelezd a tulajdonosnak a kesz-t azonositoval.\n' +
      'Felbehagyott munka nem maradhat: ha most sem tudod befejezni, commitold `wip:` uzenettel, ami leirja, hol tartasz.',
  )
  return parts.join('\n\n')
}

/** The live wiring: git in PROJECT_ROOT, the audit log in STORE_DIR. */
export function liveAbandonedDeps(projectRoot: string, storeDir: string, knownAgents: () => string[], base = 'origin/main'): AbandonedDeps {
  return {
    listWorktrees: async () => {
      const r = await defaultGit(projectRoot, ['worktree', 'list', '--porcelain'])
      if (!r.ok) throw new Error('git worktree list failed')
      return parseWorktreeList(r.out, projectRoot)
    },
    readAudit: () => {
      const p = join(storeDir, 'agent-audit.jsonl')
      // A fresh install has no audit log yet: that is "nobody worked anywhere",
      // not a failure.
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    },
    knownAgents,
    state: (path) => worktreeState(path, base),
    now: () => Date.now(),
  }
}
