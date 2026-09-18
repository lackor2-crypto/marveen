// Upstream principle gate -- baked-in review of incoming upstream changes.
//
// WHY: merging upstream by "does it conflict textually?" is not enough. A
// cleanly-mergeable change can still carry logic that contradicts THIS fork's
// principles (agent equality, no forced context cap, host-agnosticism, no
// auto-done, ...). This module bakes those principles into the code so a FRESH
// install behaves exactly like the origin install: the checklist travels with
// the repo, not with a per-machine file.
//
// THE UNIT IS THE COMMIT, not the file. A shared file (web/app.js, routes/agents.ts)
// is touched by dozens of upstream commits; a per-file verdict either drops all of
// them or lets the bad one in with the rest. Measured 2026-09-18: the per-file
// version let the "new agent comes up with the context guard armed" commit through
// because its call site lived in a file that twenty neutral commits also touched.
// The changelog list shown to the owner is per-commit for the same reason.
//
// CONTENT IS SCANNED ONLY IN EXECUTABLE SOURCE. Tests, fixtures, docs, lock files,
// vendored code and comment lines are skipped. Measured 2026-09-18 on the real
// upstream: 19 of 20 automatic exclusions came from exactly those (package-lock.json
// sponsor URLs, test fixture paths, a comment that said "auto-compact", a MiniMax
// fix that RAISES the context window). A RED verdict drops a change the owner never
// sees, so a RED detector must be high-confidence; medium confidence is a FLAG.
//
// IDENTITY IS NOT BAKED: the gate detects the *pattern* of a hardcoded identity
// (an absolute home path literal, a repo URL, ...), never a concrete name -- so
// this file itself passes template-identity-hygiene.

export type Tier = 'red' | 'flag'
export type Verdict = 'exclude' | 'discuss' | 'allow'

export interface FileChange {
  /** Repo-relative path. */
  path: string
  /** Added lines of this commit's patch for this file (without the leading '+'). */
  added: string[]
}

export interface CommitInput {
  sha: string
  /** The commit subject line. */
  subject: string
  files: FileChange[]
}

export interface Bilingual { hu: string; en: string }

export interface Finding {
  principleId: string
  tier: Tier
  /** Where it was seen: 'subject' or 'path:line-text' (trimmed), for the owner to check. */
  evidence: string
}

export interface CommitVerdict {
  sha: string
  subject: string
  verdict: Verdict
  principleId?: string
  reason?: Bilingual
  evidence?: string
  source: 'principle' | 'denylist' | 'green' | 'default'
}

export interface Principle {
  id: string
  title: Bilingual
  why: Bilingual
}

export interface DenylistEntry {
  /** Which baked principle this exclusion instances. */
  principle: string
  /** Excludes every commit that touches a path matching this glob. */
  pathPattern?: string
  /** Excludes commits whose SUBJECT matches this (case-insensitive) regex. */
  subjectPattern?: string
  /** Excludes a commit whose added content has this signature (see contentSignature). */
  contentSignature?: string
  note: string
  decidedAt: string
  decidedBy: string
}

export interface Denylist {
  version: number
  entries: DenylistEntry[]
}

export interface GateReport {
  reviewed: number
  exclude: CommitVerdict[]
  discuss: CommitVerdict[]
  allow: CommitVerdict[]
  byPrinciple: Record<string, number>
  /** Files touched by BOTH an excluded and a non-excluded commit: a plain merge
   *  cannot take one without the other, these need a hand-made cut. */
  splitFiles: string[]
}

// --- the baked principle list ------------------------------------------------

/**
 * Tier of the forced-context-cap principle for PROACTIVE guard features
 * (arming the guard by default, handoff/idle-flush/trigger tiers, auto /clear).
 * Decided by the owner on 2026-09-18 (card a1b1cba6): RED -- proactive guard
 * features are excluded automatically. Plain fixes to the existing opt-in guard
 * stay a FLAG, never auto-excluded: the guard already exists in this fork and
 * dropping its fixes would leave it broken.
 */
export const CONTEXT_CAP_PROACTIVE_TIER: Tier = 'red'

export const PRINCIPLES: Principle[] = [
  {
    id: 'agent-equality',
    title: { hu: "Ágens-egyenlőség: nincs 'egyik ágens igen, másik nem'", en: "Agent equality: no 'one agent may, another may not'" },
    why: {
      hu: 'Ebben a forkban minden ágens egyenlő; nincs kiváltságos fő-asszisztens. A bejövő ágens-megkülönböztetés szembemegy ezzel.',
      en: 'In this fork every agent is equal; there is no privileged main assistant. Incoming agent differentiation contradicts this.',
    },
  },
  {
    id: 'host-agnostic-identity',
    title: { hu: 'Gépfüggetlenség: nincs beégetett név/útvonal/repó', en: 'Host-agnosticism: no hardcoded name/path/repo' },
    why: {
      hu: 'A fork nyílt; a beégetett gépspecifikus érték csak egy gépen működik, máshol csendben elromlik.',
      en: 'The fork is open-source; a hardcoded host-specific value only works on one machine and silently breaks elsewhere.',
    },
  },
  {
    id: 'no-forced-context-cap',
    title: { hu: 'Nincs kényszerített kontextus-korlát / proaktív /clear', en: 'No forced context cap / proactive /clear' },
    why: {
      hu: 'A tulajdonos kivette a kényszerített kontextus-korlátot (handoff, újraindítás, /clear egy küszöbnél); ez nem jöhet vissza alapértelmezésként.',
      en: 'The owner removed forced context caps (handoff, restart, /clear at a threshold); they must not come back as a default.',
    },
  },
  {
    id: 'no-auto-done',
    title: { hu: "Kanban: 'kész'-re csak a tulajdonos tehet", en: "Kanban: only the owner moves a card to 'done'" },
    why: {
      hu: "Kártyát 'done'-ra kizárólag a tulajdonos tehet; egy automatikus done-mozgatás szembemegy ezzel.",
      en: "Only the owner may move a card to 'done'; an automatic done-move contradicts this.",
    },
  },
  {
    id: 'agent-differentiation-signal',
    title: { hu: 'Ágens-megkülönböztető jel (emberi ránézés kell)', en: 'Agent-differentiation signal (needs human review)' },
    why: {
      hu: 'A változás az ágensek közti egyenlőséget kikényszerítő kódot érinti. Lehet jó (egyenlőséget erősít) vagy rossz (különbséget vezet be); a tulajdonos döntse el.',
      en: 'The change touches the code that enforces agent equality. It may strengthen or weaken it; let the owner decide.',
    },
  },
  {
    id: 'new-restriction',
    title: { hu: 'Új tiltás/kapu (nem egyértelműen védő)', en: 'New restriction/gate (not clearly protective)' },
    why: {
      hu: 'Új funkció, ami megtilt vagy megállít valamit. Ha nem a pénztárcát vagy az adatot védi, a tulajdonos döntse el, kell-e.',
      en: 'A new feature that blocks or stops something. If it does not protect money or data, let the owner decide.',
    },
  },
  {
    id: 'bilingual-parity-risk',
    title: { hu: 'Kétnyelvűség-kockázat: felületi szöveg fordítás nélkül', en: 'Bilingual risk: UI text without translation' },
    why: {
      hu: 'A változás felületi fájlt módosít, de a magyar ÉS az angol nyelvi fájlt nem. Nézd meg, megvan-e mindkét nyelv.',
      en: 'The change edits a UI file but not both the Hungarian and English language files. Check both languages exist.',
    },
  },
]

const PRINCIPLE_BY_ID = new Map(PRINCIPLES.map((p) => [p.id, p]))

// --- which lines are worth scanning --------------------------------------------

const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py|sh|bash)$/i
const NON_PRODUCT = /(^|\/)(__tests__|tests?|fixtures?|vendor|node_modules|dist|docs?)\/|\.(test|spec)\.[a-z]+$|(^|\/)package-lock\.json$|\.lock$|\.md$/i

/** True for a file whose added lines are executable product code worth scanning. */
export const isScannableSource = (path: string): boolean => SOURCE_EXT.test(path) && !NON_PRODUCT.test(path)

const COMMENT_LINE = /^(\/\/|#|\*|\/\*|<!--|--\s)/

/** Executable added lines of scannable files, with their path. Comments dropped. */
function executableLines(files: FileChange[]): { path: string; line: string }[] {
  const out: { path: string; line: string }[] = []
  for (const f of files) {
    if (!isScannableSource(f.path)) continue
    for (const raw of f.added) {
      const line = raw.trim()
      if (!line || COMMENT_LINE.test(line)) continue
      out.push({ path: f.path, line })
    }
  }
  return out
}

const clip = (s: string) => (s.length > 140 ? s.slice(0, 137) + '...' : s)

// --- detectors (pattern-based, name-free) ---------------------------------------

const RE = {
  // Differentiation spelled out in the subject. "main agent" alone is NOT enough:
  // upstream has a main agent too and most such subjects are ordinary fixes.
  agentDiffStrong:
    /main[_-]?only|subagent[_-]?only|only the main agent|main[- ]agent only|(sub[- ]?agents?|other agents?) (may|can) ?not\b|privileged\s+(main|agent)|(main|sub)[- ]?agents?\s+privilege/i,
  // An absolute per-user home path literal (the classic "works on my machine").
  homeLiteral: /["'`]\/(home|Users)\/[A-Za-z0-9_.-]+\//,
  repoLiteral: /["'`][^"'`]*\b(github\.com|gitlab\.com|bitbucket\.org)[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/,
  // The proactive context-guard family, named in the subject (scope or text).
  contextGuardSubject: /context[- ]?guard|context[- ]?restart[- ]?gate|idle[- ]?flush|auto[- ]?\/?clear|proactive (\/)?clear|forced (handoff|compact|clear)/i,
  // ...and the parts of that family that ARM the guard or make it act on its own
  // (restart, handoff, flush, /clear). "feat" alone is not enough: a settings UI or
  // an alert for the opt-in guard is a FLAG, not an automatic exclusion.
  contextGuardProactive:
    /\barm(s|ed|ing)?\b|by default|default[- ]on|comes up with|trigger tier|idle[- ]?flush|handoff|auto[- ]?\/?clear|proactive (\/)?clear|wake the fresh session|forced (handoff|compact|clear|restart)/i,
  // Subject-level auto-done.
  autoDoneSubject: /auto[_-]?done|automatic(ally)? (move|set|mark)s?\b.{0,30}\bdone|(move|mark|set)s?\b.{0,20}\bto\s+["']?done\b.{0,30}\bautomatic/i,
  // Code-level auto-done: a write of status 'done' in product code.
  autoDoneCode: /(status\s*:\s*|status\s*=\s*(?!=)|moveKanbanCard\([^)]*,\s*)["'`]done["'`]/,
  negation: /\b(prevent|disable|block|forbid|never|no[- ]?auto|stop|refuse|reject|guard against|must not)\b/i,
  // A new restriction: a FEATURE commit whose subject says it gates/blocks/refuses.
  restrictionSubject: /\b(hard[- ]?gate|gate[sd]?|block(s|ed)?|refuse[sd]?|deny|denies|forbid(s|den)?|lock(s|ed)? (out|down))\b/i,
  walletProtective: /rate[_-]?limit|quota|\bkeret\b|budget|usage[_-]?limit|\bspend|\bcost|koltseg|költség/i,
  dataProtective: /backup|homoglyph|provenance|integrity|stray|checksum|\baudit\b|data[_-]?loss|prompt[- ]injection|secret|leak|csrf|path[- ]traversal/i,
  uiFile: /^web\/(index\.html|app\.js)$/,
  // A branch on "is this the main agent?" in product code...
  mainAgentBranch: /(===|!==)\s*MAIN_AGENT_ID\b|\bMAIN_AGENT_ID\s*(===|!==)|\bisMainAgent\b|\bMAIN_ONLY\w*|\bSUBAGENT_ONLY\w*/,
  // ...that is only about WHERE the main agent lives (it sits at the project root,
  // not under agents/<name>/), which is structure, not privilege.
  structural: /\b(dir|dirs|path|root|join|homedir|cwd|transcript|session|mkdir|folder|location|listAgentNames)\b|[a-z](Path|Paths|Dir|Dirs|Root|Session|Sessions)\b|(Path|Dir|Dirs|Root)\(/i,
  // ...and that decides who MAY do something: the branch line or the next few
  // added lines speak of capability, grant, deny, gate or an early refusal.
  capabilityWords: /capabilit|\bgrant|\bdeny|\bdenied|\bpermission|\bprivileg|\bexempt|\ballow(ed|list)?\b|gate\b|\bblock|\brefus|return false|return true/i,
  // Subject that says a rule applies to only part of the fleet.
  partialFleetSubject: /\b(only|not|never|exempt|except|skips?)\b.{0,40}\b(sub[- ]?agents?|main[- ]agent|the main)\b|\b(sub[- ]?agents?|main[- ]agent)\b.{0,40}\b(only|exempt|excluded|not)\b/i,
  // A visible-text literal in UI code: a quoted phrase of 2+ words starting with a letter,
  // or an HTML text node, not already routed through t()/data-i18n.
  uiText: /(["'`])[A-Za-zÀ-ž][^"'`<>{}=;:]*\s[A-Za-zÀ-ž][^"'`<>{}=;:]*\1|>\s*[A-Za-zÀ-ž][^<>{}]*\s[^<>{}]*</,
}

const isFeat = (subject: string) => /^feat(\(|:|!)/i.test(subject.trim())

/** All principle findings of one commit (RED and FLAG). Pure; no denylist. */
export function findPrinciples(c: CommitInput): Finding[] {
  const out: Finding[] = []
  const subject = c.subject
  const exec = executableLines(c.files)

  // agent-equality (RED): only a subject that SAYS it differentiates.
  if (RE.agentDiffStrong.test(subject) && !RE.negation.test(subject)) {
    out.push({ principleId: 'agent-equality', tier: 'red', evidence: 'subject' })
  }

  // host-agnostic identity: home-path literal in product code = RED;
  // a repo URL literal in product code = FLAG (upstream links to its own repo on purpose).
  const home = exec.find((l) => RE.homeLiteral.test(l.line))
  if (home) out.push({ principleId: 'host-agnostic-identity', tier: 'red', evidence: `${home.path}: ${clip(home.line)}` })
  else {
    const repo = exec.find((l) => RE.repoLiteral.test(l.line))
    if (repo) out.push({ principleId: 'host-agnostic-identity', tier: 'flag', evidence: `${repo.path}: ${clip(repo.line)}` })
  }

  // forced context cap: subject-driven. Proactive additions follow the owner's
  // tier; fixes to the existing opt-in guard are a FLAG.
  if (RE.contextGuardSubject.test(subject)) {
    // Negation is judged per clause: "daily-handoff trigger tier, and drop the field
    // that was never wired" adds a proactive tier even though "never" appears later.
    const proactive = subject
      .split(/\s+--\s+|,\s*(?:and|plus)\s+|;\s*|\s+\+\s+/i)
      .some((clause) => RE.contextGuardProactive.test(clause) && !RE.negation.test(clause))
    out.push({
      principleId: 'no-forced-context-cap',
      tier: proactive ? CONTEXT_CAP_PROACTIVE_TIER : 'flag',
      evidence: 'subject',
    })
  }

  // auto-done: subject = RED (unless negated); a 'done' write in product code = FLAG.
  if (RE.autoDoneSubject.test(subject) && !RE.negation.test(subject)) {
    out.push({ principleId: 'no-auto-done', tier: 'red', evidence: 'subject' })
  } else {
    const done = exec.find((l) => RE.autoDoneCode.test(l.line) && !RE.negation.test(l.line))
    if (done) out.push({ principleId: 'no-auto-done', tier: 'flag', evidence: `${done.path}: ${clip(done.line)}` })
  }

  // agent-differentiation signal (FLAG): the parity rulebook itself changes, a
  // product line branches on "main agent?" for something other than location,
  // or the subject says a rule covers only part of the fleet. agent-scaffold.ts
  // alone is NOT a signal: it is where every fleet-wide capability is wired.
  const parity = c.files.find((f) => /(^|\/)agent-parity\.ts$/.test(f.path) && !NON_PRODUCT.test(f.path))
  const branch = exec.find((l, i) => {
    if (!RE.mainAgentBranch.test(l.line) || RE.structural.test(l.line)) return false
    const window = exec.slice(i, i + 4).filter((w) => w.path === l.path).map((w) => w.line).join('\n')
    return RE.capabilityWords.test(window)
  })
  if (parity) out.push({ principleId: 'agent-differentiation-signal', tier: 'flag', evidence: parity.path })
  else if (branch) out.push({ principleId: 'agent-differentiation-signal', tier: 'flag', evidence: `${branch.path}: ${clip(branch.line)}` })
  else if (RE.partialFleetSubject.test(subject)) out.push({ principleId: 'agent-differentiation-signal', tier: 'flag', evidence: 'subject' })

  // new restriction (FLAG): a FEATURE that gates/blocks. A fix to an existing gate is not new.
  if (isFeat(subject) && RE.restrictionSubject.test(subject)) {
    out.push({ principleId: 'new-restriction', tier: 'flag', evidence: 'subject' })
  }

  // bilingual risk (FLAG): a UI file gains a visible-text literal while hu.js and
  // en.js are not both touched. A UI change with no new text is not a risk.
  const paths = new Set(c.files.map((f) => f.path))
  if (!(paths.has('web/lang/hu.js') && paths.has('web/lang/en.js'))) {
    for (const f of c.files) {
      if (!RE.uiFile.test(f.path)) continue
      const hit = f.added.map((l) => l.trim()).find((l) => l && !COMMENT_LINE.test(l) && RE.uiText.test(l) && !/\bt\(|data-i18n|console\.|throw |Error\(|class=|className|querySelector|getElementById|addEventListener|fetch\(|\/api\//.test(l))
      if (hit) { out.push({ principleId: 'bilingual-parity-risk', tier: 'flag', evidence: `${f.path}: ${clip(hit)}` }); break }
    }
  }
  return out
}

/** True when the commit is a protective (wallet/data) guard -> GREEN over FLAGs. */
export const isProtective = (c: CommitInput): boolean =>
  RE.walletProtective.test(c.subject) || RE.dataProtective.test(c.subject)

// --- denylist -------------------------------------------------------------------

const globToRe = (glob: string): RegExp =>
  new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, ' ')
        .replace(/\*\*/g, '')
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '(?:.*/)?')
        .replace(//g, '.*') +
      '$',
  )

/** Order-independent, whitespace-normalized signature of added content (FNV-1a hex). */
export const contentSignature = (addedLines: string[]): string => {
  const normd = addedLines
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort()
    .join('\n')
  let h = 0x811c9dc5
  for (let i = 0; i < normd.length; i++) {
    h ^= normd.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const commitAdded = (c: CommitInput) => c.files.flatMap((f) => f.added)

export function denylistHit(c: CommitInput, denylist: Denylist): DenylistEntry | undefined {
  const added = commitAdded(c)
  for (const e of denylist.entries) {
    if (e.pathPattern) {
      const re = globToRe(e.pathPattern)
      if (c.files.some((f) => re.test(f.path))) return e
    }
    if (e.subjectPattern && new RegExp(e.subjectPattern, 'i').test(c.subject)) return e
    // An empty patch shares one fixed signature; a signature entry must not match all of them.
    if (e.contentSignature && added.some((l) => l.trim()) && contentSignature(added) === e.contentSignature) return e
  }
  return undefined
}

// --- the classifier -------------------------------------------------------------

export function classifyCommit(c: CommitInput, denylist: Denylist): CommitVerdict {
  const base = { sha: c.sha, subject: c.subject }
  const findings = findPrinciples(c)

  // 1) RED principles win outright (auto-exclude).
  const red = findings.find((f) => f.tier === 'red')
  if (red) {
    return { ...base, verdict: 'exclude', principleId: red.principleId, reason: PRINCIPLE_BY_ID.get(red.principleId)!.why, evidence: red.evidence, source: 'principle' }
  }

  // 2) committed denylist (explicit standing decisions).
  const hit = denylistHit(c, denylist)
  if (hit) {
    return { ...base, verdict: 'exclude', principleId: hit.principle, reason: { hu: hit.note, en: hit.note }, source: 'denylist' }
  }

  // 3) protective guards are GREEN even if a FLAG rule would otherwise fire --
  //    except a context-cap flag: "protective" wording must not smuggle a cap in.
  const flags = findings.filter((f) => f.tier === 'flag')
  const capFlag = flags.find((f) => f.principleId === 'no-forced-context-cap')
  if (!capFlag && isProtective(c)) {
    return { ...base, verdict: 'allow', reason: { hu: 'védő (pénztárca/adat) változás', en: 'protective (wallet/data) change' }, source: 'green' }
  }

  // 4) FLAG -> owner decides.
  const flag = capFlag ?? flags[0]
  if (flag) {
    return { ...base, verdict: 'discuss', principleId: flag.principleId, reason: PRINCIPLE_BY_ID.get(flag.principleId)!.why, evidence: flag.evidence, source: 'principle' }
  }

  // 5) nothing tripped.
  return { ...base, verdict: 'allow', source: 'default' }
}

export function runGate(commits: CommitInput[], denylist: Denylist): GateReport {
  const report: GateReport = { reviewed: commits.length, exclude: [], discuss: [], allow: [], byPrinciple: {}, splitFiles: [] }
  const excludedFiles = new Set<string>()
  const keptFiles = new Set<string>()
  for (const c of commits) {
    const v = classifyCommit(c, denylist)
    report[v.verdict].push(v)
    if (v.principleId) report.byPrinciple[v.principleId] = (report.byPrinciple[v.principleId] ?? 0) + 1
    for (const f of c.files) (v.verdict === 'exclude' ? excludedFiles : keptFiles).add(f.path)
  }
  report.splitFiles = [...excludedFiles].filter((p) => keptFiles.has(p)).sort()
  return report
}

export const EMPTY_DENYLIST: Denylist = { version: 1, entries: [] }

/** Validate a denylist object loaded from disk; throws on a shape error (never silently treats bad input as empty). */
export function parseDenylist(raw: unknown): Denylist {
  if (!raw || typeof raw !== 'object') throw new Error('denylist: not an object')
  const d = raw as Partial<Denylist>
  if (typeof d.version !== 'number') throw new Error('denylist: missing numeric version')
  if (!Array.isArray(d.entries)) throw new Error('denylist: entries must be an array')
  for (const e of d.entries) {
    if (!e || typeof e.principle !== 'string') throw new Error('denylist: entry missing principle')
    if (!e.pathPattern && !e.contentSignature && !e.subjectPattern)
      throw new Error('denylist: entry needs pathPattern, subjectPattern or contentSignature')
    if (!PRINCIPLE_BY_ID.has(e.principle)) throw new Error(`denylist: unknown principle '${e.principle}'`)
    if (e.subjectPattern) {
      try { new RegExp(e.subjectPattern, 'i') } catch { throw new Error(`denylist: invalid subjectPattern '${e.subjectPattern}'`) }
    }
    if (typeof e.note !== 'string' || !e.note.trim()) throw new Error('denylist: entry needs a note (why it is excluded)')
  }
  return d as Denylist
}
