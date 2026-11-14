// #824: boots a DISPOSABLE web-only Marveen (empty store, temp depot, seeded project) for the live browser suite.
//
// Safety: this starts a real server that writes store/claudeclaw.db and store/.dashboard-token of THIS checkout. It
// therefore refuses to run when it finds a database it did not create (a live install), and the global teardown removes
// only what carries this suite's own marker file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE = path.join(ROOT, 'store')
const MARKER = path.join(STORE, '.browser-live-owned')
export const IDS_FILE = path.join(os.tmpdir(), 'marveen-live-browser-ids.json')
const PORT = parseInt(process.env.LIVE_BROWSER_PORT || '3498', 10)

fs.mkdirSync(STORE, { recursive: true })
const dbFile = path.join(STORE, 'claudeclaw.db')
if (fs.existsSync(dbFile)) {
  if (!fs.existsSync(MARKER)) {
    console.error('REFUSING: ' + dbFile + ' exists and was not created by the live browser suite (a live install?). Run the suite from a clean checkout / worktree.')
    process.exit(3)
  }
  // a crashed earlier run of this suite: its leftovers are ours
  for (const f of fs.readdirSync(STORE)) if (f.startsWith('claudeclaw.db') || f === '.dashboard-token') fs.rmSync(path.join(STORE, f), { force: true })
}
fs.writeFileSync(MARKER, String(Date.now()))

const depot = fs.mkdtempSync(path.join(os.tmpdir(), 'marveen-live-depot-'))
process.env.MARVEEN_DEPOT = depot
process.env.WEB_ONLY = 'true'
process.env.WEB_PORT = String(PORT)

const [d, m, p, w, dm] = await Promise.all([
  import(path.join(ROOT, 'src/db.ts')), import(path.join(ROOT, 'src/web.ts')), import(path.join(ROOT, 'src/projects.ts')),
  import(path.join(ROOT, 'src/workbench.ts')), import(path.join(ROOT, 'src/workbench-docmodel.ts')),
])
d.initDatabase()

const root = path.join(depot, 'Projektek', 'teszt')
for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++) fs.mkdirSync(path.join(root, 'Ugy ' + String(i).padStart(2, '0'), 'Resz ' + j), { recursive: true })
// a saved signature (1x1 PNG) for the signature picker spec
fs.writeFileSync(path.join(depot, 'Alairas teszt.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
// an uploaded file in the item's folder, so the Life-tree move dialog has something to list
fs.mkdirSync(path.join(root, 'Ugy 00', 'Feltöltések'), { recursive: true })
fs.writeFileSync(path.join(root, 'Ugy 00', 'Feltöltések', 'irat.txt'), 'teszt irat')
const pr = (p as any).createProject({ name: 'Teszt projekt', folder_path: 'Projektek/teszt' })
if (!pr.ok) throw new Error('project ' + pr.code)
const it = (w as any).createWorkItem({ project_id: pr.project.id, title: 'Level', type: 'document', container_folder: 'Ugy 00' })
if (!it.ok) throw new Error('item ' + JSON.stringify(it))
const sec = (dm as any).addSection(it.item.id, 'Level')
if (!sec.ok) throw new Error('section ' + JSON.stringify(sec))
const blk = (dm as any).addBlock(it.item.id, sec.section.id, { kind: 'paragraph', text: 'Tisztelt Hivatal!', author: 'agent' })
if (!blk.ok) throw new Error('block ' + JSON.stringify(blk))

fs.writeFileSync(IDS_FILE, JSON.stringify({ pid: pr.project.id, itemId: it.item.id, port: PORT, depot, root: ROOT }))
;(m as any).startWebServer(PORT)
console.log('LIVE-BROWSER-READY ' + PORT)
