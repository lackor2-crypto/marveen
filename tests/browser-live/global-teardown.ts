// #824: removes EVERYTHING serve.mts's server created in THIS checkout's store/ (database, token, rate-limit-status, locks ...),
// but only when the suite's own marker is there, so a live install is never touched. See store-guard.ts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanStore } from './store-guard'

export default async function globalTeardown(): Promise<void> {
  const root = process.cwd()
  const store = path.join(root, 'store')
  const idsFile = path.join(os.tmpdir(), 'marveen-live-browser-ids.json')
  try {
    cleanStore(store)
    if (fs.existsSync(idsFile)) {
      const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'))
      if (ids.depot && String(ids.depot).startsWith(path.join(os.tmpdir(), 'marveen-live-depot-'))) fs.rmSync(ids.depot, { recursive: true, force: true })
      fs.rmSync(idsFile, { force: true })
    }
  } catch { /* teardown must never fail the run */ }
}
