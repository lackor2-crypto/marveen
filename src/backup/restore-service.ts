/**
 * Restore, as the running dashboard does it (#396 Phase 4/5): open a backup for
 * the preview, then -- after the owner confirms -- make the pre-restore backup,
 * write the plan and hand over to the detached runner.
 *
 * Previews live in memory for a limited time; their staged folder is what the
 * restore moves into place (store/tmp/restore-stage-*, swept after 1 h).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { inspectBackup, type Inspection } from './inspect.js'
import { buildRestorePlan, pauseStagedSchedules, FLAG, RESULT, heldPending, type RestoreOutcome } from './restore.js'
import { findKeyById } from './key-store.js'
import { readHeader } from './crypto.js'
import type { BackupCategory } from './inventory.js'
import type { RestoreCtx } from './path-rewrite.js'
import { lockPath } from './create.js'

const PREVIEW_TTL_MS = 55 * 60 * 1000

interface Preview { id: string; file: string; inspection: Inspection; at: number; uploaded: boolean }
const previews = new Map<string, Preview>()

export class RestoreError extends Error {
  code: string
  vars: Record<string, string>
  constructor(code: string, vars: Record<string, string> = {}) { super(code); this.code = code; this.vars = vars }
}

function sweep(): void {
  for (const [id, p] of previews) {
    if (Date.now() - p.at > PREVIEW_TTL_MS) { dropPreview(id) }
  }
}

export function dropPreview(id: string): void {
  const p = previews.get(id)
  if (!p) return
  rmSync(p.inspection.stagingDir, { recursive: true, force: true })
  if (p.uploaded) rmSync(p.file, { force: true })
  previews.delete(id)
}

export function getPreview(id: string): Preview | null {
  sweep()
  return previews.get(id) ?? null
}

/** The key: the one typed in, or the stored one with the header's key id. */
export function resolveKey(storeDir: string, file: string, typed?: string | null): string {
  if (typed && typed.trim()) return typed
  const { header } = readHeader(file)
  const k = findKeyById(storeDir, header.keyId)
  if (!k) throw new RestoreError('key_needed', { keyId: header.keyId })
  return k.key
}

export async function openPreview(o: {
  file: string; uploaded: boolean; key?: string | null; ctx: RestoreCtx; appVersion: string; currentDb: Database.Database | string | null
}): Promise<{ id: string; inspection: Inspection }> {
  sweep()
  const key = resolveKey(o.ctx.storeDir, o.file, o.key)
  const inspection = await inspectBackup({ file: o.file, recoveryKey: key, ctx: o.ctx, appVersion: o.appVersion, currentDb: o.currentDb })
  const id = randomBytes(8).toString('hex')
  previews.set(id, { id, file: o.file, inspection, at: Date.now(), uploaded: o.uploaded })
  return { id, inspection }
}

export interface StartDeps {
  ctx: RestoreCtx
  /** The pre-restore backup; resolves ok/false. */
  preBackup: () => Promise<{ ok: boolean; error?: string; detail?: string }>
  /** The dashboard's service unit, or null when it cannot restart itself. */
  unit: string | null
  unitReason?: string
  /** Hand the plan to the runner (real: systemd-run). */
  launch: (planFile: string) => void
}

export async function startRestore(previewId: string, exclude: BackupCategory[], d: StartDeps): Promise<{ planId: string; preBackup: 'made' | 'skipped_fresh' }> {
  const p = getPreview(previewId)
  if (!p) throw new RestoreError('preview_expired')
  const ins = p.inspection
  if (!ins.compat.ok) throw new RestoreError(ins.compat.reason ?? 'format_unknown')
  if (!ins.bytes.enough) throw new RestoreError('disk_space', { need: String(ins.bytes.payload * 3), free: String(ins.bytes.free ?? 0) })
  if (!existsSync(ins.stagingDir)) { dropPreview(previewId); throw new RestoreError('preview_expired') }
  if (existsSync(join(d.ctx.storeDir, FLAG))) throw new RestoreError('restore_running')
  if (existsSync(lockPath(d.ctx.storeDir))) throw new RestoreError('busy')
  if (!d.unit) throw new RestoreError('cannot_restart', { reason: d.unitReason ?? '' })

  let pre: 'made' | 'skipped_fresh' = 'made'
  const r = await d.preBackup()
  if (!r.ok) {
    // Nothing to protect on a fresh install -- otherwise never go on without it.
    if (!ins.freshInstall) throw new RestoreError('pre_backup_failed', { detail: r.detail || r.error || '' })
    pre = 'skipped_fresh'
  }

  const plan = buildRestorePlan({ id: previewId, file: p.file, stagingDir: ins.stagingDir, manifest: ins.manifest, ctx: d.ctx, exclude })
  const dbItem = plan.items.find((i) => i.category === 'database')
  plan.pausedTaskIds = dbItem ? pauseStagedSchedules(dbItem.staged) : []
  plan.unit = d.unit
  const dir = join(d.ctx.storeDir, 'tmp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const planFile = join(dir, `restore-plan-${plan.id}.json`)
  writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 })
  rmSync(join(d.ctx.storeDir, RESULT), { force: true })
  previews.delete(previewId) // the runner owns the staged folder now
  d.launch(planFile)
  return { planId: plan.id, preBackup: pre }
}

/** Real launcher: the runner lives outside the dashboard's own service, so stopping that does not stop it. */
export function launchRunner(projectRoot: string, planFile: string): void {
  const runner = join(projectRoot, 'dist', 'backup', 'restore-runner.js')
  const child = spawn('systemd-run', ['--user', '--collect', '--quiet', '--description=Marveen restore (#396)', process.execPath, runner, planFile], { detached: true, stdio: 'ignore' })
  child.unref()
}

export interface RestoreStatus {
  running: boolean
  result: RestoreOutcome | null
  channelsHeld: boolean
}

export function restoreStatus(storeDir: string): RestoreStatus {
  let result: RestoreOutcome | null = null
  try { result = JSON.parse(readFileSync(join(storeDir, RESULT), 'utf8')) } catch { result = null }
  return { running: existsSync(join(storeDir, FLAG)), result, channelsHeld: heldPending(storeDir) }
}
