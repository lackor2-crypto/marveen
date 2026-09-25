/**
 * The detached restore runner (#396 Phase 4, plan §2.1 "Execution of restore").
 *
 * The dashboard holds the database open, so it cannot replace it: it writes a
 * plan file, starts THIS process outside its own service (systemd-run), and the
 * runner then
 *   1. takes the backup/restore lock (waits while a backup finishes),
 *   2. stops the dashboard service,
 *   3. performs the restore (flag -> move aside -> move in -> check -> or roll back),
 *   4. starts the dashboard again.
 * The result lands in store/restore-result.json, which the page reads after the
 * restart. If this process dies half-way, the next dashboard start sees the
 * flag and rolls back (recoverInterruptedRestore in src/index.ts).
 *
 *   node dist/backup/restore-runner.js <planFile>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { acquireBackupLock } from './create.js'
import { performRestore, type RestoreOutcome, type RestorePlan } from './restore.js'

export interface RunnerHooks {
  stop: () => void
  start: () => void
  sleep?: (ms: number) => Promise<void>
  lockWaitMs?: number
}

export function systemdHooks(unit: string): RunnerHooks {
  return {
    stop: () => { execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: 120_000 }) },
    start: () => { execFileSync('systemctl', ['--user', 'start', unit], { stdio: 'ignore', timeout: 120_000 }) },
  }
}

export async function runRestore(plan: RestorePlan, hooks: RunnerHooks, opts: { failAt?: string } = {}): Promise<RestoreOutcome> {
  const sleep = hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (hooks.lockWaitMs ?? 10 * 60 * 1000)
  let release = acquireBackupLock(plan.ctx.storeDir, 'restore')
  while (!release && Date.now() < deadline) {
    await sleep(2000)
    release = acquireBackupLock(plan.ctx.storeDir, 'restore')
  }
  if (!release) {
    return { ok: false, reason: 'a backup is still running', rolledBack: false, finishedAt: Date.now(), planId: plan.id }
  }
  let outcome: RestoreOutcome
  try {
    try { hooks.stop() } catch (e: any) {
      return { ok: false, reason: `could not stop the dashboard: ${e?.message || e}`, rolledBack: false, finishedAt: Date.now(), planId: plan.id }
    }
    outcome = performRestore(plan, opts)
  } finally {
    release()
    // Whatever happened, the dashboard comes back: restored, or rolled back.
    try { hooks.start() } catch { /* systemd Restart= brings it back; the result file tells the rest */ }
  }
  return outcome
}

async function main(argv: string[]): Promise<number> {
  const planFile = argv[0]
  if (!planFile) { console.error('usage: restore-runner.js <planFile>'); return 2 }
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as RestorePlan
  if (!plan.unit) { console.error('restore: no service unit in the plan'); return 2 }
  const out = await runRestore(plan, systemdHooks(plan.unit))
  rmSync(planFile, { force: true })
  console.log(`restore: ${out.ok ? 'done' : `FAILED (${out.reason})${out.rolledBack ? ', rolled back' : ''}`}`)
  return out.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`restore: FAILED: ${e?.stack || e}`); process.exit(1) })
}
