// PARANCS-TIPUSU UTEMEZES: a parancs NEM allithatja meg a vezerlopultot.
//
// 2026-08-22: a napi git-lehuzas kartyaja ezen bukott el. A parancsot
// `spawnSync` inditotta, ami a teljes esemenyhurkot blokkolja -- es mivel a
// parancs egy `curl`-lel VISSZAHIV a Marveenbe, holtpont lett belole: a
// szerver nem tudott valaszolni, mert eppen a valaszra varo parancsot
// futtatta. A curl idotullepett, a kartya "hibas"-nak latszott, a parancs
// pedig vegig jo volt.
//
// Ugyanez minden mas parancs-kartyara is igaz: barmelyik lassu ellenorzes
// befagyasztotta az egesz feluletet a sajat idotullepeseig.
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-cmdtask-'))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  // Uzenetet nem kuldunk: ez a teszt a futtatasrol szol, nem a riasztasrol.
  return { ...actual, STORE_DIR: store, TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../db.js', () => ({ appendTaskRun: () => { /* nincs adatbazis a tesztben */ } }))

const { runCommandTask } = await import('../web/command-task.js')

const HEALTH = join(store, 'command-task-health.json')

function feladat(name: string, command: string, timeoutMs: number) {
  return {
    name, command, timeoutMs,
    description: name, prompt: '', schedule: '0 4 * * *',
    agent: 'proba', enabled: true, createdAt: 0, type: 'command' as const,
    failThreshold: 1,
  }
}

/** Megvarja, amig a parancs elkonyveli magat -- de nem a vegtelensegig. */
async function varjEredmenyt(name: string, maxMs = 8000): Promise<any> {
  const hatarido = Date.now() + maxMs
  while (Date.now() < hatarido) {
    if (existsSync(HEALTH)) {
      try {
        const d = JSON.parse(readFileSync(HEALTH, 'utf-8'))
        if (d[name]) return d[name]
      } catch { /* eppen irodik */ }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

describe('runCommandTask', () => {
  it('AZONNAL visszater, nem varja meg a parancsot', async () => {
    const t0 = Date.now()
    runCommandTask(feladat('proba-alvo', 'sleep 2', 20000), Date.now())
    const eltelt = Date.now() - t0
    // A `sleep 2` meg javaban fut. Ha itt 2 masodperc telt volna el, az
    // pontosan az a holtpont lenne, ami miatt ez a teszt letezik.
    expect(eltelt).toBeLessThan(500)

    // ...es az eredmeny attol meg megerkezik.
    const e = await varjEredmenyt('proba-alvo')
    expect(e?.lastStatus).toBe('ok')
    expect(e?.fails).toBe(0)
  })

  it('a hibas parancsot hibanak konyveli, a stderr-rel egyutt', async () => {
    runCommandTask(feladat('proba-bukott', 'echo "baj van" >&2; exit 3', 20000), Date.now())
    const e = await varjEredmenyt('proba-bukott')
    expect(e?.lastStatus).toBe('fail')
    expect(e?.fails).toBe(1)
  })

  it('a tulsokaig futo parancsot LEALLITJA', async () => {
    // Idotullepes nelkul egy beragadt parancs orokre ott maradna.
    runCommandTask(feladat('proba-ragad', 'sleep 30', 400), Date.now())
    const e = await varjEredmenyt('proba-ragad')
    expect(e?.lastStatus).toBe('fail')
  })
})
