// #860: worker thread entry for inspectDatabaseFileAsync (db-snapshot.ts): integrity check + table counts of a
// database file, so the dashboard's event loop is not held while a backup inspects the 153 MB database.
import { parentPort, workerData } from 'node:worker_threads'
import { inspectDatabaseFile } from './db-snapshot.js'

try {
  parentPort?.postMessage({ ok: true, info: inspectDatabaseFile((workerData as { file: string }).file) })
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
}
