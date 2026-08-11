// HTTP surface for the Windows settings backup (kanban fc904177).
//
// Sits beside /api/persistent-windows rather than inside it: window layout and
// registry settings are different mechanisms with different risk, and Boss asked
// for them as two separate Settings sections ("csinálsz még egy másik gombot...
// ablak elrendezés és Windows stílus"). No pull-from-GitHub endpoint here, by
// his instruction -- Marveen holds the saved copy itself.

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  readWindowsSettingsStatus,
  saveWindowsSettings,
  restoreWindowsSettings,
  WINDOWS_SETTING_GROUPS,
  listSettingsBackups,
  undoWindowsSettings,
} from '../../windows-settings.js'
import { pushWindowsSettings } from '../../persistent-windows-sync.js'
import { startFolderIconScan, isScanRunning, getLastScanError, restoreFolderIcons, readFolderIconsManifest } from '../../folder-icons.js'
import type { RouteContext } from './types.js'

export async function tryHandleWindowsSettings(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/windows-settings' && method === 'GET') {
    try {
      json(res, {
        ...readWindowsSettingsStatus(),
        groups: WINDOWS_SETTING_GROUPS.map(g => ({ id: g.id, label: g.label })),
        // The panel needs this to decide whether an undo is even offerable --
        // a disabled-looking button with nothing behind it would be worse than none.
        backupList: listSettingsBackups().slice(0, 10),
        // Folder icons are a separate mechanism (files, not registry) but the
        // same button to Boss, so its state rides along in one status call.
        folderIcons: (() => {
          const m = readFolderIconsManifest()
          const base = { scanning: isScanRunning(), error: getLastScanError() }
          return m ? { ...base, scannedAt: m.scannedAt, count: m.entries.length, drives: m.drives } : { ...base, scannedAt: null, count: 0, drives: [] }
        })(),
      })
    } catch (err) {
      logger.error({ err }, 'windows-settings status failed')
      json(res, { error: 'Status failed' }, 500)
    }
    return true
  }

  if (path === '/api/windows-settings/save' && method === 'POST') {
    try {
      await readBody(req)
      const saved = await saveWindowsSettings()
      // Custom folder icons live in desktop.ini files, not the registry, so the
      // scan is a separate pass -- but it is the same click for Boss, and he
      // asked for the whole machine to be covered. Started, not awaited: a
      // full-drive scan runs for minutes and would turn this click into a hang.
      const folderIcons = { started: startFolderIconScan() }
      // Publishing is the second half of "save", same as on the layout side, so
      // the off-machine copy is never a separate thing to remember. A failed push
      // does not undo a good local save, so it is reported alongside, not instead.
      let pushed: { ok: boolean; error: string | null } = { ok: false, error: null }
      if (saved.ok) {
        try {
          await pushWindowsSettings()
          pushed = { ok: true, error: null }
        } catch (err) {
          pushed = { ok: false, error: String((err as Error).message ?? err) }
          logger.warn({ err }, 'windows-settings: save succeeded but push failed')
        }
      }
      json(res, { ...saved, pushed, folderIcons })
    } catch (err) {
      logger.error({ err }, 'windows-settings save failed')
      json(res, { error: 'Save failed' }, 500)
    }
    return true
  }

  // Undo: go back to the state captured just before the last restore. Same
  // machinery as a restore, pointed at the safety copy instead of the backup.
  if (path === '/api/windows-settings/undo' && method === 'POST') {
    try {
      const body = await readBody(req)
      let backupId: string | undefined
      try { backupId = JSON.parse(body.toString() || '{}').backupId } catch { /* newest */ }
      json(res, await undoWindowsSettings(backupId))
    } catch (err) {
      logger.error({ err }, 'windows-settings undo failed')
      json(res, { error: 'Undo failed' }, 500)
    }
    return true
  }

  if (path === '/api/windows-settings/restore' && method === 'POST') {
    try {
      await readBody(req)
      // ORDER MATTERS: folder icons go back BEFORE the registry restore, because
      // restoreWindowsSettings ends by restarting Explorer, and Explorer reads
      // folder customisation as it starts. Writing the desktop.ini files after
      // that restart would leave them invisible until the next one -- another
      // "it says it worked and nothing changed" of exactly the kind that cost
      // this feature two rounds already.
      let folderIcons: { restored: number; failed: number; error: string | null } = { restored: 0, failed: 0, error: null }
      try {
        const icons = await restoreFolderIcons()
        folderIcons = { restored: icons.restored.length, failed: icons.failed.length, error: null }
      } catch (err) {
        folderIcons = { restored: 0, failed: 0, error: String((err as Error).message ?? err) }
        logger.warn({ err }, 'windows-settings: folder icon restore failed')
      }
      const restored = await restoreWindowsSettings()
      json(res, { ...restored, folderIcons })
    } catch (err) {
      logger.error({ err }, 'windows-settings restore failed')
      json(res, { error: 'Restore failed' }, 500)
    }
    return true
  }

  return false
}
