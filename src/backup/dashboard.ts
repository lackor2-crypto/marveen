/**
 * The full backup inside the running dashboard (#396): the daily timer, using
 * the dashboard's own open database handle for the snapshot.
 */
import { APP_TZ, STORE_DIR } from '../config.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { startBackupScheduler } from './scheduler.js'
import { join } from 'node:path'
import { runBackup, spawnVerify, localBackupDir } from './service.js'

export function startDashboardBackup(): () => void {
  return startBackupScheduler({
    storeDir: STORE_DIR,
    tz: APP_TZ,
    run: async () => {
      const r = await runBackup({ kind: 'scheduled', db: getDb() })
      if (r.skipped) return
      if (r.ok) logger.info({ file: r.name, size: r.size, replicas: r.replicas }, 'Scheduled full backup done')
      else logger.warn({ error: r.error, detail: r.detail }, 'Scheduled full backup failed')
    },
    verify: (name) => { void spawnVerify(['verify', join(localBackupDir(STORE_DIR), name), '--record']) },
    offsite: () => { void spawnVerify(['verify-offsite']) },
    log: (msg, extra) => logger.warn(extra ?? {}, msg),
  })
}
