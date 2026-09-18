/**
 * TETELENKENTI TORLES-MEGEROSITO SOR (kanban #301).
 *
 * Amit ez a fajl orzi:
 *   1. A sor a MOSTANI kephez igazodik: uj tetel bekerul, okafogyott kikerul,
 *      a regi tetel megtartja az eszrevetel idejet.
 *   2. A "nem" tartos: a kovetkezo futas nem kerdezi ujra, amig a helyzet
 *      fennall -- utana elfelejtodik.
 *   3. Olvashatatlan sor fole nem irunk.
 *   4. A szinkron-motor magatol NEM torol: a felmeno agban nincs kozvetlen
 *      `trashDriveFile` hivas, csak a jovahagyas utjan.
 *   5. Friss telepites: nincs fajl -> ures sor, hiba nelkul.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deleteQueuePath, itemId, loadDeleteQueue, removePairFromQueue, removeQueueItem,
  setDeleteQueueStoreDir, syncQueueForPair,
} from '../drive-delete-queue.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

const tetel = (driveId: string, relPath = `mappa/${driveId}.txt`) => ({
  pairLabel: 'a teljes Drive', account: 'fiok', driveId, relPath, localPath: `/depo/${relPath}`, size: 1,
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ddel-'))
  setDeleteQueueStoreDir(dir)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('friss telepites', () => {
  it('nincs fajl -> ures sor, hiba nelkul', () => {
    expect(loadDeleteQueue()).toEqual({ items: [], dismissed: [], readError: '' })
  })
})

describe('a sor a mostani kephez igazodik', () => {
  it('uj tetel bekerul, okafogyott kikerul, a regi ideje megmarad', () => {
    expect(syncQueueForPair('p1', 'up', [tetel('a'), tetel('b')], 'T1')).toEqual({ added: 2, removed: 0, total: 2 })
    expect(syncQueueForPair('p1', 'up', [tetel('b'), tetel('c')], 'T2')).toEqual({ added: 1, removed: 1, total: 2 })
    const items = loadDeleteQueue().items
    expect(items.map((i) => i.driveId).sort()).toEqual(['b', 'c'])
    expect(items.find((i) => i.driveId === 'b')!.detectedAt).toBe('T1')
    expect(items.find((i) => i.driveId === 'c')!.detectedAt).toBe('T2')
  })

  it('a masik irany es a masik paros tetelei erintetlenek', () => {
    syncQueueForPair('p1', 'up', [tetel('a')])
    syncQueueForPair('p1', 'down', [tetel('x')])
    syncQueueForPair('p2', 'up', [tetel('a')])
    syncQueueForPair('p1', 'up', [])
    expect(loadDeleteQueue().items.map((i) => i.id).sort()).toEqual([itemId('down', 'p1', 'x'), itemId('up', 'p2', 'a')].sort())
  })
})

describe('a "nem" tartos', () => {
  it('elutasitott tetel nem kerul vissza, amig a helyzet fennall', () => {
    syncQueueForPair('p1', 'down', [tetel('a')])
    expect(removeQueueItem(itemId('down', 'p1', 'a'), true)).toBe(true)
    syncQueueForPair('p1', 'down', [tetel('a')])
    expect(loadDeleteQueue().items).toEqual([])
    // A helyzet megszunt -> az elutasitas is elfelejtodik...
    syncQueueForPair('p1', 'down', [])
    expect(loadDeleteQueue().dismissed).toEqual([])
    // ...es ha ujra elofordul, ujra kerdezunk.
    syncQueueForPair('p1', 'down', [tetel('a')])
    expect(loadDeleteQueue().items.length).toBe(1)
  })

  it('igen utan (dismiss nelkul) nincs megjegyzett elutasitas', () => {
    syncQueueForPair('p1', 'up', [tetel('a')])
    removeQueueItem(itemId('up', 'p1', 'a'))
    expect(loadDeleteQueue().dismissed).toEqual([])
  })

  it('a paros levalasztasa a teteleit es az elutasitasait is viszi', () => {
    syncQueueForPair('p1', 'up', [tetel('a'), tetel('b')])
    removeQueueItem(itemId('up', 'p1', 'a'), true)
    removePairFromQueue('p1')
    expect(loadDeleteQueue()).toEqual({ items: [], dismissed: [], readError: '' })
  })
})

describe('olvashatatlan sor', () => {
  it('nem irjuk felul, es a hibat kimondjuk', () => {
    writeFileSync(deleteQueuePath(), '{ serult')
    const load = loadDeleteQueue()
    expect(load.readError).not.toBe('')
    expect(syncQueueForPair('p1', 'up', [tetel('a')])).toEqual({ added: 0, removed: 0, total: 0 })
    expect(readFileSync(deleteQueuePath(), 'utf8')).toBe('{ serult')
  })
})

describe('a szinkron-motor magatol nem torol', () => {
  const route = readFileSync(join(ROOT, 'src', 'web', 'routes', 'drive-sync.ts'), 'utf8')

  it('trashDriveFile CSAK a jovahagyas utjan hivodik', () => {
    const hivasok = route.split('await trashDriveFile(').length - 1
    expect(hivasok).toBe(1)
    const i = route.indexOf('await trashDriveFile(')
    expect(route.lastIndexOf('export async function decideDeletion', i)).toBeGreaterThan(-1)
    expect(route.lastIndexOf('async function uploadPhase', i)).toBeLessThan(route.lastIndexOf('export async function decideDeletion', i))
  })

  it('mindket irany a sorba kerul, a helyi torles a Kukaba megy', () => {
    expect(route).toContain("syncQueueForPair(pair.id, 'up'")
    expect(route).toContain("syncQueueForPair(pair.id, 'down'")
    expect(route).toContain('trashLife(rel)')
    expect(route).toContain("path === '/api/drive/sync/deletions/decide'")
  })

  it('a felulet a lap tetejen mutatja, es minden igen elott megerosit', () => {
    const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
    const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
    expect(html.indexOf('id="depoDelQueue"')).toBeLessThan(html.indexOf('id="depoSyncList"'))
    expect(app).toContain("t('ddel.confirm_up'")
    expect(app).toContain("t('ddel.confirm_down'")
  })

  it('minden ddel-kulcs megvan mindket nyelven', () => {
    const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
    const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
    const kulcsok = (s: string) => [...s.matchAll(/'(ddel\.[a-z_]+)':/g)].map((m) => m[1]).sort()
    expect(kulcsok(hu).length).toBeGreaterThan(10)
    expect(kulcsok(hu)).toEqual(kulcsok(en))
  })
})
