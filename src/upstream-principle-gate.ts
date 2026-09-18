// Upstream principle gate -- baked-in review of incoming upstream changes.
//
// WHY: merging upstream by "does it conflict textually?" is not enough. A
// cleanly-mergeable file can still carry logic that contradicts THIS fork's
// principles (agent equality, no forced context cap, host-agnosticism, no
// auto-done, ...). This module bakes those principles into the code so a FRESH
// install behaves exactly like the origin install: the checklist travels with
// the repo, not with a per-machine file.
//
// IDENTITY IS NOT BAKED: the gate detects the *pattern* of a hardcoded identity
// (an absolute home path, a repo URL, a long numeric chat id, ...), never a
// concrete name -- so this file itself passes template-identity-hygiene.
//
// Two-tier decision (owner's wording): high-confidence violation -> RED (auto
// excluded from install); a weaker signal -> FLAG (owner decides). Protective
// guards (wallet/keret, data/integrity) are GREEN by default.

export type Tier = "red" | "flag";
export type Verdict = "exclude" | "discuss" | "allow";

export interface ChangeInput {
  /** Repo-relative path of the changed file. */
  path: string;
  /** Conventional-commit subjects of the upstream commits touching this file (joined). */
  subjects?: string;
  /** Added lines of the patch (optional; sharpens detection when available). */
  addedLines?: string[];
}

export interface Principle {
  id: string;
  tier: Tier;
  title: { hu: string; en: string };
  why: { hu: string; en: string };
  /** Returns true when this change trips the principle. Pattern-based, name-free. */
  detect: (c: NormalizedChange) => boolean;
}

export interface NormalizedChange {
  path: string;
  /** lower-cased path + subjects, for cheap matching. */
  hay: string;
  added: string;
}

export interface DenylistEntry {
  /** Which baked principle this exclusion instances. */
  principle: string;
  /** Stable signature: a normalized path pattern (glob-ish) OR a content hash. Never a raw upstream commit hash. */
  pathPattern?: string;
  contentSignature?: string;
  note: string;
  decidedAt: string;
  decidedBy: string;
}

export interface Denylist {
  version: number;
  entries: DenylistEntry[];
}

export interface FileVerdict {
  path: string;
  verdict: Verdict;
  principleId?: string;
  reason?: string;
  source: "principle" | "denylist" | "green" | "default";
}

export interface GateReport {
  reviewed: number;
  exclude: FileVerdict[];
  discuss: FileVerdict[];
  allow: FileVerdict[];
  byPrinciple: Record<string, number>;
}

// --- helpers (name-free pattern detectors) -----------------------------------

const norm = (c: ChangeInput): NormalizedChange => ({
  path: c.path,
  hay: (c.path + " " + (c.subjects ?? "")).toLowerCase(),
  added: (c.addedLines ?? []).join("\n"),
});

/** An added *executable* line hardcoding a host-specific value (not a comment). */
const hasHardcodedIdentityPattern = (added: string): boolean => {
  const lines = added.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // skip obvious comment lines -- comments may name people (allowed).
    if (/^(\/\/|#|\*|<!--)/.test(line)) continue;
    if (
      /["'`]\/(home|users|root|mnt)\/[a-z0-9_.-]+/i.test(line) || // absolute host-specific path literal
      /(github|gitlab)\.com[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|bitbucket\.org[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(line) || // repo URL literal
      /\bchat_id\b\s*[:=]\s*["']?\d{6,}/i.test(line) || // hardcoded numeric chat id
      /\.service\b/.test(line) && /["'`][a-z0-9_-]+\.service["'`]/i.test(line) // systemd unit literal
    ) {
      return true;
    }
  }
  return false;
};

const RE = {
  // NOTE: RED detectors are deliberately conservative. A RED verdict auto-EXCLUDES
  // (irreversible-ish: the owner never sees a dropped change), so a broad token here
  // silently discards legitimate/protective upstream fixes. When confidence is only
  // medium, prefer a FLAG (owner decides) over a RED. That is why 'privileg', bare
  // '50%'/'150k' were removed from the RED patterns below -- they matched innocent
  // fixes ("fix privilege check", "cap backup at 150k", "50% opacity").
  agentDiffStrong:
    /main[_-]?only|subagent[_-]?only|only the main agent|main[- ]agent only|csak a (fo|fő)[- ]?(agens|ágens)|privileg\w*\s+(agent|agens|ágens|main)|(main|sub)[- ]?agent\w*\s+privileg/i,
  agentDiffSignal: /agent-parity|agent-scaffold|per[_-]?agent|fleet-parity/i,
  contextCap:
    /auto[- ]?\/?clear|auto[- ]?compact|context[- ]?(window[- ]?)?cap|token[- ]?cap|forced (compact|handoff)|(context|token|window)\b.{0,24}\b(cap|150k|50%)|\b(150k|50%)\b.{0,24}(context|token|window|compact|clear)/i,
  autoDone: /(auto[_-]?done)|(move[sd]?\b.{0,20}\bto\s+["']?done)|(status\s*[:=]\s*["']?done.{0,30}(auto|automatic))/i,
  // A change that PREVENTS auto-done aligns with our principle -- do not exclude it.
  autoDoneNegated: /prevent|disable|block|forbid|guard|never|no[- ]?auto|stop|megakadalyoz|megakadályoz|letilt|tilt/i,
  bilingualRisk: /(web\/index\.html|web\/app\.js)$/i,
  guardSignal: /\bgate\b|\bguard\b|approval|permission|jovahagy|jóváhagy|engedely|engedély|block|blokk|tilt|forbid|deny/i,
  walletProtective:
    /rate[_-]?limit|quota|keret|budget|usage[_-]?limit|spend|cost|koltseg|költség|token[_-]?budget/i,
  dataProtective:
    /backup|homoglyph|provenance|integrity|no-stray|stray|checksum|audit|data[_-]?loss/i,
};

// --- the baked principle list ------------------------------------------------
// Ordered: RED first (auto-exclude), then FLAG. GREEN protective handling is in
// classify(), not here, so that a protective guard is never mislabelled RED.

export const PRINCIPLES: Principle[] = [
  {
    id: "agent-equality",
    tier: "red",
    title: {
      hu: "Agens-egyenloseg: nincs 'egyik agens igen, masik nem'",
      en: "Agent equality: no 'one agent may, another may not'",
    },
    why: {
      hu: "Ebben a forkban minden agens egyenlo; nincs privilegizalt fo-asszisztens. A bejovo agent-megkulonboztetes szembemegy ezzel.",
      en: "In this fork every agent is equal; there is no privileged main assistant. Incoming agent-differentiation contradicts this.",
    },
    detect: (c) => RE.agentDiffStrong.test(c.hay),
  },
  {
    id: "host-agnostic-identity",
    tier: "red",
    title: {
      hu: "Host-agnoszticitas: nincs beegetett nev/id/path/repo/port",
      en: "Host-agnosticism: no hardcoded name/id/path/repo/port",
    },
    why: {
      hu: "A fork nyilt; a beegetett gepspecifikus ertek csak ezen a gepen mukodik, masen csendben elromlik.",
      en: "The fork is open-source; a hardcoded host-specific value only works on this machine and silently breaks elsewhere.",
    },
    detect: (c) => hasHardcodedIdentityPattern(c.added),
  },
  {
    id: "no-forced-context-cap",
    tier: "red",
    title: {
      hu: "Nincs kenyszeritett kontextus-cap / proaktiv /clear",
      en: "No forced context cap / proactive /clear",
    },
    why: {
      hu: "A tulajdonos kifejezetten kivette a kenyszeritett kontextus-ablak korlatot (150K/50%, auto-/clear); ez a fajta korlat nem jon vissza.",
      en: "The owner explicitly removed forced context-window caps (150K/50%, auto-/clear); this kind of cap must not return.",
    },
    detect: (c) => RE.contextCap.test(c.hay) || RE.contextCap.test(c.added.toLowerCase()),
  },
  {
    id: "no-auto-done",
    tier: "red",
    title: {
      hu: "Kanban: nincs auto-done (csak a tulajdonos)",
      en: "Kanban: no auto-done (owner only)",
    },
    why: {
      hu: "Kartyat 'done'-ra kizarolag a tulajdonos tehet; egy automatikus done-mozgatas szembemegy ezzel.",
      en: "Only the owner may move a card to 'done'; an automatic done-move contradicts this.",
    },
    detect: (c) =>
      (RE.autoDone.test(c.hay) || RE.autoDone.test(c.added.toLowerCase())) &&
      !RE.autoDoneNegated.test(c.hay),
  },
  {
    id: "agent-differentiation-signal",
    tier: "flag",
    title: {
      hu: "Agent-megkulonbozteto jel (emberi ranezes kell)",
      en: "Agent-differentiation signal (needs human review)",
    },
    why: {
      hu: "A valtozas az agens-kulonbsegtetel infrastrukturajat erinti (parity/scaffold). Lehet egyenloseget kikenyszerito (jo) vagy megkulonbozteto (rossz) -- a tulajdonos dontse el.",
      en: "The change touches agent-differentiation infrastructure (parity/scaffold). It may enforce equality (good) or introduce differentiation (bad) -- let the owner decide.",
    },
    detect: (c) => RE.agentDiffSignal.test(c.hay),
  },
  {
    id: "new-guard-gate",
    tier: "flag",
    title: {
      hu: "Uj gate/guard/approval (nem egyertelmuen vedo)",
      en: "New gate/guard/approval (not clearly protective)",
    },
    why: {
      hu: "A valtozas korlatot/kaput vezet be. Ha nem penztarca-/adat-vedo, a tulajdonos dontse el, kell-e.",
      en: "The change introduces a restriction/gate. If it is not wallet/data protective, let the owner decide.",
    },
    detect: (c) => RE.guardSignal.test(c.hay),
  },
  {
    id: "bilingual-parity-risk",
    tier: "flag",
    title: {
      hu: "Ketnyelvuseg-kockazat: uj feluleti szoveg",
      en: "Bilingual-parity risk: new UI text",
    },
    why: {
      hu: "Kepernyore kerulo szoveg magyarul ES angolul is kell. A felulet-fajl valtozasat a tulajdonos nezze at, megvan-e mindket nyelv.",
      en: "On-screen text must exist in both Hungarian and English. A UI-file change should be reviewed for both languages.",
    },
    detect: (c) => RE.bilingualRisk.test(c.path),
  },
];

const PRINCIPLE_BY_ID = new Map(PRINCIPLES.map((p) => [p.id, p]));

/** True when a change is clearly a protective (wallet/data) guard -> GREEN. */
export const isProtectiveGuard = (c: NormalizedChange): boolean =>
  RE.walletProtective.test(c.hay) || RE.dataProtective.test(c.hay);

// --- denylist matching (stable signatures, never raw upstream hashes) --------

const globToRe = (glob: string): RegExp =>
  new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, " ")
        .replace(/\*/g, "[^/]*")
        .replace(/ /g, ".*") +
      "$",
  );

const denylistHit = (change: ChangeInput, denylist: Denylist): DenylistEntry | undefined => {
  for (const e of denylist.entries) {
    if (e.pathPattern && globToRe(e.pathPattern).test(change.path)) return e;
    // Guard empty added-lines: contentSignature([]) is a fixed hash that every
    // deletion-only / binary diff shares -- a signature entry must not match them all.
    if (
      e.contentSignature &&
      change.addedLines &&
      change.addedLines.length > 0 &&
      contentSignature(change.addedLines) === e.contentSignature
    )
      return e;
  }
  return undefined;
};

/** Order-independent, whitespace-normalized signature of added content (FNV-1a hex). */
export const contentSignature = (addedLines: string[]): string => {
  const normd = addedLines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .sort()
    .join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < normd.length; i++) {
    h ^= normd.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

// --- the classifier ----------------------------------------------------------

export function classifyChange(input: ChangeInput, denylist: Denylist): FileVerdict {
  const c = norm(input);

  // 1) RED principles win outright (auto-exclude).
  for (const p of PRINCIPLES) {
    if (p.tier === "red" && p.detect(c)) {
      return { path: input.path, verdict: "exclude", principleId: p.id, reason: p.why.hu, source: "principle" };
    }
  }

  // 2) committed denylist (explicit prior decisions).
  const hit = denylistHit(input, denylist);
  if (hit) {
    return {
      path: input.path,
      verdict: "exclude",
      principleId: hit.principle,
      reason: hit.note,
      source: "denylist",
    };
  }

  // 3) protective guards are GREEN even if a FLAG rule would otherwise fire.
  if (isProtectiveGuard(c)) {
    return { path: input.path, verdict: "allow", reason: "protective (wallet/data) guard", source: "green" };
  }

  // 4) FLAG principles -> owner decides.
  for (const p of PRINCIPLES) {
    if (p.tier === "flag" && p.detect(c)) {
      return { path: input.path, verdict: "discuss", principleId: p.id, reason: p.why.hu, source: "principle" };
    }
  }

  // 5) nothing tripped.
  return { path: input.path, verdict: "allow", source: "default" };
}

export function runGate(changes: ChangeInput[], denylist: Denylist): GateReport {
  const report: GateReport = { reviewed: changes.length, exclude: [], discuss: [], allow: [], byPrinciple: {} };
  for (const ch of changes) {
    const v = classifyChange(ch, denylist);
    if (v.verdict === "exclude") report.exclude.push(v);
    else if (v.verdict === "discuss") report.discuss.push(v);
    else report.allow.push(v);
    if (v.principleId) report.byPrinciple[v.principleId] = (report.byPrinciple[v.principleId] ?? 0) + 1;
  }
  return report;
}

export const EMPTY_DENYLIST: Denylist = { version: 1, entries: [] };

/** Validate a denylist object loaded from disk; throws on a shape error (never silently treats bad input as empty). */
export function parseDenylist(raw: unknown): Denylist {
  if (!raw || typeof raw !== "object") throw new Error("denylist: not an object");
  const d = raw as Partial<Denylist>;
  if (typeof d.version !== "number") throw new Error("denylist: missing numeric version");
  if (!Array.isArray(d.entries)) throw new Error("denylist: entries must be an array");
  for (const e of d.entries) {
    if (!e || typeof e.principle !== "string") throw new Error("denylist: entry missing principle");
    if (!e.pathPattern && !e.contentSignature) throw new Error("denylist: entry needs pathPattern or contentSignature");
    if (e.principle !== "_test_" && !PRINCIPLE_BY_ID.has(e.principle))
      throw new Error(`denylist: unknown principle '${e.principle}'`);
  }
  return d as Denylist;
}
