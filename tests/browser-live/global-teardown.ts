// #824: removes what serve.mts created in THIS checkout's store/, but only when the suite's own marker is there, so a live
// install is never touched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export default async function globalTeardown(): Promise<void> {
  const root = process.cwd()
  const store = path.join(root, 'store')
  const marker = path.join(store, '.browser-live-owned')
  const idsFile = path.join(os.tmpdir(), 'marveen-live-browser-ids.json')
  try {
    if (fs.existsSync(marker)) {
      for (const f of fs.readdirSync(store)) if (f.startsWith('claudeclaw.db') || f === '.dashboard-token' || f === '.browser-live-owned') fs.rmSync(path.join(store, f), { force: true })
    }
    if (fs.existsSync(idsFile)) {
      const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'))
      if (ids.depot && String(ids.depot).startsWith(path.join(os.tmpdir(), 'marveen-live-depot-'))) fs.rmSync(ids.depot, { recursive: true, force: true })
      fs.rmSync(idsFile, { force: true })
    }
  } catch { /* teardown must never fail the run */ }
}
