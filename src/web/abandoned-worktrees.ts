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
import { open, stat } from 'node:fs/promises'
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

/**
 * How long the SessionStart route waits for the scan. The hook gives the whole
 * answer 12 s (pending-work-replay.py) and that answer also carries the wake
 * greeting and the pending-work replay: a slow scan (dozens of worktrees on a
 * loaded host) must cost only its own line, never the rest.
 */
export const SCAN_BUDGET_MS = 6_000

/** `scan`, or -- if it has not answered within `ms` -- "could not look". Never "nothing abandoned". */
export function withScanBudget(scan: Promise<AbandonedResult>, ms: number = SCAN_BUDGET_MS): Promise<AbandonedResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<AbandonedResult>((res) => {
    timer = setTimeout(() => res({ items: [], unowned: [], olvashatatlan: true }), ms)
  })
  return Promise.race([scan, late]).finally(() => clearTimeout(timer))
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Owner of each worktree from the audit log. Two strengths of evidence, and a
 * strong one always beats a weak one (within the same strength the LATER line
 * wins -- the log is append-only):
 *   strong: a file operation (edit/write/delete/move) inside the worktree, or
 *           the command that CREATED it (`agent-worktree.sh <name>`);
 *   weak:   the session's cwd inside it, or a Bash command that `cd`s into it
 *           (heredoc/sed edits are Bash commands, not file operations).
 * So an agent that only looked into someone else's worktree (a weak signal)
 * never takes it over from the one who created or edited it.
 *
 * WHO is the session's own agent (`session_agent`, from the directory the
 * session was started in), not `agent`: the audit hook derives `agent` from
 * the cwd, so inside `.worktrees/<name>` it says `<name>` -- the worktree, not
 * the agent (#366, measured: 9 of 17 lackor3-* worktrees came out unowned).
 * Old lines without `session_agent` fall back to `agent`. Unknown agents
 * (code-bridge sessions, worktree names) never own anything.
 */
export function attributeOwners(auditText: string, paths: string[], knownAgents: string[]): Map<string, string | null> {
  const scan = ownerScanner(paths, knownAgents)
  scan.feed(auditText)
  return scan.owners()
}

export interface OwnerScanner {
  /** Feed complete audit lines, in log order (a trailing partial line is parsed as-is). */
  feed(text: string): void
  owners(): Map<string, string | null>
}

/**
 * The incremental form of `attributeOwners`: the log is append-only and the
 * later line wins, so feeding it chunk by chunk gives the same answer as one
 * pass over the whole text (#390: the full 16 MB log x 73 worktrees used to
 * stall the whole server for 1-3 s on every SessionStart).
 */
export function ownerScanner(paths: string[], knownAgents: string[]): OwnerScanner {
  const known = new Set(knownAgents)
  const strong = new Map<string, string | null>(paths.map((p) => [p, null]))
  const weak = new Map<string, string | null>(paths.map((p) => [p, null]))
  // A worktree is named after its folder; a creation command names only that.
  const baseCount = new Map<string, number>()
  for (const p of paths) {
    const b = p.replace(/\/+$/, '').split('/').pop() ?? ''
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1)
  }
  const probes = paths.map((p) => {
    const clean = p.replace(/\/+$/, '')
    const base = clean.split('/').pop() ?? ''
    const unique = baseCount.get(base) === 1
    const end = `(?=$|[\\s/"';&|)])`
    return {
      p,
      pre: clean + '/',
      // A worktree under `.worktrees/<name>` (whose name survives JSON
      // encoding unchanged) can only be hit by a line that says
      // `.worktrees/<name>` -- every hit below spells out the full path or
      // that -- or by a creation command. Such lines are found by name below,
      // the rest skipped before JSON.parse and the regexes.
      indexed: clean.endsWith(`/.worktrees/${base}`) && /^[A-Za-z0-9._-]+$/.test(base) ? base : null,
      created: unique ? new RegExp(`agent-worktree\\.sh\\s+["']?${escapeRe(base)}["']?(?=$|[\\s;&|)])`) : null,
      cdInto: new RegExp(`\\bcd\\s+["']?(?:${escapeRe(clean)}|(?:\\S*/)?\\.worktrees/${escapeRe(base)})${end}`),
    }
  })
  const byName = new Map<string, typeof probes>()
  const always: typeof probes = []
  for (const pr of probes) {
    if (pr.indexed == null) { always.push(pr); continue }
    const l = byName.get(pr.indexed) ?? []
    l.push(pr)
    byName.set(pr.indexed, l)
  }
  const NAME_CHAR = /[A-Za-z0-9._-]/
  const candidates = (line: string): typeof probes => {
    if (line.includes('agent-worktree')) return probes
    const hit = new Set(always)
    const mark = '.worktrees/'
    for (let i = line.indexOf(mark); i >= 0; i = line.indexOf(mark, i + 1)) {
      let j = i + mark.length
      while (j < line.length && NAME_CHAR.test(line[j])) j++
      for (const pr of byName.get(line.slice(i + mark.length, j)) ?? []) hit.add(pr)
    }
    return [...hit]
  }
  const feed = (text: string): void => {
    for (const line of text.split('\n')) {
      if (!line.includes('/') && !line.includes('agent-worktree')) continue
      const cand = candidates(line)
      if (!cand.length) continue
      let rec: { agent?: string; session_agent?: string; op?: string; target?: string; cwd?: string }
      try { rec = JSON.parse(line) } catch { continue }
      const who = typeof rec.session_agent === 'string' ? rec.session_agent : rec.agent
      if (!who || !known.has(who)) continue
      const target = typeof rec.target === 'string' ? rec.target : ''
      const isBash = rec.op === 'bash'
      for (const pr of cand) {
        const hitFile = FILE_OPS.has(rec.op ?? '') && target.startsWith(pr.pre)
        const hitCreate = isBash && pr.created != null && pr.created.test(target)
        if (hitFile || hitCreate) { strong.set(pr.p, who); continue }
        const hitCwd = typeof rec.cwd === 'string' && (rec.cwd === pr.p || rec.cwd.startsWith(pr.pre))
        const hitCd = isBash && pr.cdInto.test(target)
        if (hitCwd || hitCd) weak.set(pr.p, who)
      }
    }
  }
  const owners = (): Map<string, string | null> => {
    const out = new Map<string, string | null>()
    for (const p of paths) out.set(p, strong.get(p) ?? weak.get(p) ?? null)
    return out
  }
  return { feed, owners }
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
  /** Optional faster path for the owners (the live wiring reads the log incrementally). */
  owners?: (paths: string[], knownAgents: string[]) => Promise<Map<string, string | null>>
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
    const paths = wts.map((w) => w.path)
    const owners = deps.owners
      ? await deps.owners(paths, deps.knownAgents())
      : attributeOwners(deps.readAudit(), paths, deps.knownAgents())
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
      '  2. Ha a sor szerint a tartalom MAR A MAINEN VAN (vagy a munka mas formaban mar landolt -- nezd meg a main-t), a worktree csak maradek: NE landold ujra, hanem TOROLD kerdezes nelkul -- `scripts/agent-worktree.sh --remove <nev>` (a tulajdonos allando engedelye, 2026-09-25, #384: "ha keszen vagy akkor torlesnek automatikusnak kellene lennie"). Commitolatlan valtozast ez a parancs nem dob el: ha megtagadja, a maradek megsem ures -- akkor vidd keszre, ne eroltesd (--force).\n' +
      '  3. Ha egy tetel megsem a tied, irj a gazdajanak inter-agent uzenetet -- idegen worktree-be nem irsz.\n' +
      '  4. A kesz munka kartyajat tedd "waiting"-be, es jelezd a tulajdonosnak a kesz-t azonositoval.\n' +
      'Felbehagyott munka nem maradhat: ha most sem tudod befejezni, commitold `wip:` uzenettel, ami leirja, hol tartasz.',
  )
  return parts.join('\n\n')
}

interface AuditScanMemo { key: string; ino: number; size: number; tail: string; scan: OwnerScanner }
let auditScanMemo: AuditScanMemo | null = null
export function _resetAuditScanMemoForTest(): void { auditScanMemo = null }

/** Lines per slice before the scan gives the event loop a turn. */
const FEED_SLICE_LINES = 2000

/** `scan.feed(text)` in slices, yielding between them: a first full scan of a big log must not freeze the server. */
async function feedYielding(scan: OwnerScanner, text: string): Promise<void> {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += FEED_SLICE_LINES) {
    scan.feed(lines.slice(i, i + FEED_SLICE_LINES).join('\n'))
    if (i + FEED_SLICE_LINES < lines.length) await new Promise((r) => setImmediate(r))
  }
}

/**
 * Owners from the audit log at `file`, reading only what was appended since
 * the last call (same worktrees, same agents, same file that only grew). A
 * rotated/truncated log or a changed worktree set starts over. The unfinished
 * last line is kept back until its newline arrives. Missing file = nobody
 * worked anywhere (a fresh install), not a failure; other read errors throw
 * (the caller reports "could not look").
 */
export async function ownersFromAuditFile(file: string, paths: string[], knownAgents: string[]): Promise<Map<string, string | null>> {
  let st
  try { st = await stat(file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { auditScanMemo = null; return attributeOwners('', paths, knownAgents) }
    throw e
  }
  const key = JSON.stringify([paths, knownAgents])
  let m = auditScanMemo
  if (!m || m.key !== key || m.ino !== st.ino || st.size < m.size) {
    m = { key, ino: st.ino, size: 0, tail: '', scan: ownerScanner(paths, knownAgents) }
  }
  if (st.size > m.size) {
    const fh = await open(file, 'r')
    try {
      const buf = Buffer.alloc(st.size - m.size)
      const { bytesRead } = await fh.read(buf, 0, buf.length, m.size)
      const text = m.tail + buf.subarray(0, bytesRead).toString('utf8')
      const nl = text.lastIndexOf('\n')
      await feedYielding(m.scan, nl >= 0 ? text.slice(0, nl) : '')
      m.tail = nl >= 0 ? text.slice(nl + 1) : text
      m.size += bytesRead
    } finally { await fh.close() }
  }
  auditScanMemo = m
  // The kept-back partial line is not an answer yet; a copy so callers cannot touch the memo.
  return new Map(m.scan.owners())
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
    owners: (paths, agents) => ownersFromAuditFile(join(storeDir, 'agent-audit.jsonl'), paths, agents),
    knownAgents,
    state: (path) => worktreeState(path, base),
    now: () => Date.now(),
  }
}
