/**
 * AUDIT (kanban #336, 2. fazis, spec 5/16. lepes).
 *
 * NEM uj naplo: ugyanabba a `store/agent-audit.jsonl`-be ir, amit a flotta
 * hook-jai (`scripts/hooks/agent-audit-log.py`) hasznalnak, ugyanazokkal a
 * mezokkel (`ts`, `agent`, `tool`, `op`, `target`, `cwd`). Igy a Munkapad
 * lepesei ugyanott, ugyanabban a formaban latszanak, mint minden mas agens-
 * muvelet -- ez a spec 0.1 "kozos audit reteg" kikotese.
 *
 * Az iras BEST-EFFORT: egy nem irhato naplo nem allithatja meg a munkat (a
 * hook is igy mukodik), de a hibat elnyelni csendben nem szabad -- a logger
 * megkapja.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const AUDIT_PATH = join(STORE_DIR, 'agent-audit.jsonl')

export interface AuditEntry {
  /** Ki csinalta. A Munkapadnal a bejelentkezett felhasznalo vagy a hivo fajtaja. */
  agent: string
  /** Melyik eszkoz. A hook `tool` mezojevel egy oszlopban. */
  tool: string
  /** Mi tortent: `read`, `write`, `agent-answer`, `approval-request`, ... */
  op: string
  /** Mire vonatkozott (fajl, work item id, projekt id). */
  target: string
  /** Munkakornyezet -- a Munkapadnal a projekt id-je. */
  cwd: string
}

type Writer = (path: string, line: string) => void
let writer: Writer = (path, line) => appendFileSync(path, line, 'utf-8')

/** Csak teszthez: az iras cserelese. `null` visszaallitja a valodit. */
export function setAuditWriterForTest(w: Writer | null): void {
  writer = w || ((path, line) => appendFileSync(path, line, 'utf-8'))
}

export function auditWorkbench(entry: AuditEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString().slice(0, 19),
    agent: entry.agent,
    tool: entry.tool,
    op: entry.op,
    target: entry.target,
    cwd: entry.cwd,
  }) + '\n'
  try {
    writer(AUDIT_PATH, line)
  } catch (err) {
    logger.warn({ err, path: AUDIT_PATH }, 'workbench-agent: audit line could not be written')
  }
}
