// #965: worker thread entry for copyDatabaseFileAsync (db-snapshot.ts): the online backup of the database runs here, so
// its synchronous page-copy steps never hold the dashboard's event loop.
import { parentPort, workerData } from 'node:worker_threads'
import { copyDatabaseFile } from './db-snapshot.js'

const { file, destFile } = workerData as { file: string; destFile: string }
copyDatabaseFile(file, destFile).then(
  () => parentPort?.postMessage({ ok: true }),
  (e) => parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) }),
)
