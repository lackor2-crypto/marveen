// A kod-hid befejezes-ertesitese a TELEPITES nyelven szoljon.
//
// Boss, 2026-09-06: "ha angolra van allitva akor angolul". A dashboard nyelve
// atallithato (MARVEEN_LANG / .lang), a Telegramra meno ertesites viszont
// beegetett magyar volt -- egy angol telepitesen a tulajdonos magyar fejlecet
// kapott a sajat angol eredmenye fole.
//
// Amit ez a fajl BIZONYIT (nem csak illeszt):
//  1. minden allapot-ag (done / error / egyeb / fail-verdikt / noresponse) es
//     minden alany-ag (feladat / kartya / jovahagyas) atall angolra;
//  2. angol modban NEM marad benne magyar szo -- ez a sopres fogja meg azt,
//     ha valaki kesobb visszaír egy beegetett sztringet EGY agba;
//  3. magyar modban a szoveg valtozatlan (a meglevo telepitesek nem mozdulnak);
//  4. a vegrehajto sajat szovege (task.result / task.error) SZO SZERINT megy at
//     -- azt ez a reteg nem forditja es nem is torpitheti.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCompletionMessage, resolveTaskSubject, notifyText } from '../web/code-bridge-notify.js'
import { buildCodeTaskPreamble } from '../web/code-task-preamble.js'
import type { CodeTask } from '../web/code-bridge-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** A minimalis task: csak az a mezo szamit, amit az uzenet olvas. A tobbi
 *  null/0, hogy a teszt ne fuggjon a tarolo allapotatol -- friss telepitesen is
 *  ugyanezt kell adnia. */
function task(over: Partial<CodeTask> = {}): CodeTask {
  return {
    id: 'abcdef0123456789',
    project: 'tradingbot',
    prompt: 'do the thing',
    status: 'done',
    origin: 'dashboard',
    requestedBy: null,
    chatId: null,
    sessionId: null,
    targetSessionId: null,
    workspacePath: null,
    host: null,
    result: null,
    summary: null,
    error: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    attempts: 1,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    cardRef: null,
    ...over,
  } as CodeTask
}

// A magyar jelenlet merteke: ezek a szavak KIZAROLAG a magyar valtozatban
// fordulhatnak elo. (Az ekezet nelkuli irasmod szandekos -- a fajl vegig ugy ir.)
const HU_WORDS = ['Kod-hid', 'kesz', 'hiba', 'Feladat:', 'Kartya #', 'Jovahagyas:', 'Teljes eredmeny', 'ellenorzes']

describe('a befejezes-ertesites a telepites nyelven szol', () => {
  it('angol modban egyetlen allapot-agban sem marad magyar szo', () => {
    const cases: CodeTask[] = [
      task({ status: 'done', result: 'All green.' }),
      task({ status: 'error', error: 'workspace not found' }),
      task({ status: 'running' as CodeTask['status'] }),
    ]
    for (const t of cases) {
      const msg = buildCompletionMessage(t, 'en')
      for (const w of HU_WORDS) {
        expect(msg, `"${w}" benne maradt: ${msg}`).not.toContain(w)
      }
      expect(msg).toContain('Code bridge')
      expect(msg).toContain('Full result: /result')
    }
  })

  it('magyar modban valtozatlan a szoveg (a meglevo telepites nem mozdul)', () => {
    const msg = buildCompletionMessage(task({ status: 'done', result: 'Kesz.' }), 'hu')
    expect(msg).toContain('✅ Kod-hid: tradingbot kesz')
    expect(msg).toContain('Teljes eredmeny: /result abcdef01')
    expect(buildCompletionMessage(task({ status: 'error', error: 'x' }), 'hu')).toContain('❌ Kod-hid: tradingbot hiba')
  })

  it('az alany (kartya nelkuli feladat) is atall', () => {
    expect(resolveTaskSubject(task(), 'hu').label).toBe('Feladat: do the thing')
    expect(resolveTaskSubject(task(), 'en').label).toBe('Task: do the thing')
  })

  it('a vegrehajto sajat szovegehez EGYIK nyelven sem nyul hozza', () => {
    const raw = 'Refactored resolveX(); 3 tests added. Warning: flaky on Node 20.'
    expect(buildCompletionMessage(task({ result: raw }), 'en')).toContain(raw)
    expect(buildCompletionMessage(task({ result: raw }), 'hu')).toContain(raw)
    const err = 'ENOENT: no such file or directory'
    expect(buildCompletionMessage(task({ status: 'error', error: err }), 'en')).toContain(err)
  })

  it('ismeretlen kulcsnal a kulcsot adja vissza, nem ures sztringet', () => {
    // Ures sztring ugy nezne ki, mintha nem lett volna mit kiirni.
    expect(notifyText('nincs.ilyen.kulcs', 'en')).toBe('nincs.ilyen.kulcs')
  })

  it('a helykitolto nev bennmarad, ha nincs hozza ertek -- nem tunik el nemán', () => {
    expect(notifyText('head.done', 'en')).toContain('{project}')
  })
})

describe('a vegrehajto megkapja, milyen nyelven irja a zaro osszefoglalot', () => {
  const base = { workspacePath: 'F:\\Munka', hostKind: 'wsl' as const, projectRoot: '/srv/marveen', distro: 'X' }

  it('magyar telepitesen magyarul keri', () => {
    const p = buildCodeTaskPreamble({ ...base, lang: 'hu' })
    expect(p).toContain('5.')
    expect(p).toContain('MAGYARUL')
  })

  it('angol telepitesen angolul keri, magyar szo nelkul', () => {
    const p = buildCodeTaskPreamble({ ...base, lang: 'en' })
    expect(p).toContain('ENGLISH')
    expect(p).not.toContain('MAGYARUL')
  })
})

describe('a nyelv-valasztas EGY helyen dol el', () => {
  it('a notify nem tartalmaz tobb beegetett magyar fejlecet a tablan kivul', () => {
    // A tabla utan mar semmi nem irhat sajat "Kod-hid" sztringet: ha valaki
    // megis, ez a szamlalo elhasal, es nem a tulajdonos veszi eszre elesben.
    const src = readFileSync(join(__dirname, '../web/code-bridge-notify.ts'), 'utf-8')
    const table = src.indexOf('const NOTIFY_TEXT')
    const tableEnd = src.indexOf('export function notifyText')
    expect(table).toBeGreaterThan(-1)
    const outside = src.slice(0, table) + src.slice(tableEnd)
    // A fajl fejlec-kommentje nem tartalmaz ilyet; a kodban sem szabad.
    expect(outside).not.toContain('Kod-hid:')
    expect(outside).not.toContain('Teljes eredmeny:')
  })
})
