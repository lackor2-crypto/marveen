// #824: boots a DISPOSABLE web-only Marveen (empty store, temp depot, seeded project) for the live browser suite.
//
// Safety: this starts a real server that writes store/claudeclaw.db and store/.dashboard-token of THIS checkout. It
// therefore refuses to run when it finds a database it did not create (a live install), and the global teardown removes
// only what carries this suite's own marker file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareStore } from './store-guard.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STORE = path.join(ROOT, 'store')
export const IDS_FILE = path.join(os.tmpdir(), 'marveen-live-browser-ids.json')
const PORT = parseInt(process.env.LIVE_BROWSER_PORT || '3498', 10)

const prepared = prepareStore(STORE)
if (prepared.refuse) {
  console.error(prepared.refuse)
  process.exit(3)
}

const depot = fs.mkdtempSync(path.join(os.tmpdir(), 'marveen-live-depot-'))
process.env.MARVEEN_DEPOT = depot
process.env.WEB_ONLY = 'true'
process.env.WEB_PORT = String(PORT)

const [d, m, p, w, dm, lh, dt] = await Promise.all([
  import(path.join(ROOT, 'src/db.ts')), import(path.join(ROOT, 'src/web.ts')), import(path.join(ROOT, 'src/projects.ts')),
  import(path.join(ROOT, 'src/workbench.ts')), import(path.join(ROOT, 'src/workbench-docmodel.ts')),
  import(path.join(ROOT, 'src/workbench-letterhead.ts')), import(path.join(ROOT, 'src/workbench-doclang-translate.ts')),
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

// #851: an official letter with its window-envelope head (sender table top right, recipient below) and its saved German
// version, so the spec can measure where the head stands on the original page and on the translation page.
fs.mkdirSync(path.join(root, 'Ugy 01'), { recursive: true })
const lt = (w as any).createWorkItem({ project_id: pr.project.id, title: 'Hivatalos level', type: 'document', container_folder: 'Ugy 01' })
if (!lt.ok) throw new Error('letter item ' + JSON.stringify(lt))
const lsec = (dm as any).addSection(lt.item.id, 'Level')
if (!lsec.ok) throw new Error('letter section ' + JSON.stringify(lsec))
const headHu = (lh as any).buildLetterHead('hu', ['Korpás László', 'Fő utca 1.', '1234 Budapest'], ['Minijob-Zentrale', '45115 Essen'])
const headDe = (lh as any).buildLetterHead('de', ['Korpás László', 'Fő utca 1.', '1234 Budapest'], ['Minijob-Zentrale', '45115 Essen'])
for (const [kind, text] of [['table', headHu.table], ['paragraph', headHu.paragraph], ['paragraph', 'Tisztelt Hölgyem!'], ['paragraph', 'Kérem a kérelmem elbírálását.']] as const) {
  const r = (dm as any).addBlock(lt.item.id, lsec.section.id, { kind, text, author: 'agent' })
  if (!r.ok) throw new Error('letter block ' + JSON.stringify(r))
}
const saved = (dt as any).saveShownTranslation((w as any).getWorkItem(lt.item.id), 'de', [{ source_section: lsec.section.id, title: 'Brief', blocks: [
  { kind: 'table', text: headDe.table, claims: [] }, { kind: 'paragraph', text: headDe.paragraph, claims: [] },
  { kind: 'paragraph', text: 'Sehr geehrte Damen!', claims: [] }, { kind: 'paragraph', text: 'Ich bitte um Pruefung meines Antrags.', claims: [] },
] }], null)
if (!saved.ok) throw new Error('letter translation ' + JSON.stringify(saved))

fs.writeFileSync(IDS_FILE, JSON.stringify({ pid: pr.project.id, itemId: it.item.id, letterId: lt.item.id, port: PORT, depot, root: ROOT }))
;(m as any).startWebServer(PORT)
console.log('LIVE-BROWSER-READY ' + PORT)
