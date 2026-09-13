// HAROM MERT HIBA ORE, mind a 2026-09-13-i eles menetbol (kartya c795a495).
//
// Mindharmat a tulaj vette eszre a sajat feluleten, nem teszt -- ezert kap
// mindharom sajat tesztet, hogy masodszor mar a gep fogja meg.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  resetCodeBridgeTablesForTests,
  upsertCodeSession, getCodeSession,
  dismissCodeWorkspace, isDismissedWorkspace,
  workspaceKey, sameWorkspace,
} from '../web/code-bridge-store.js'
import { isUnderAgentsDir } from '../web/routes/code.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

beforeEach(() => {
  initDatabase(':memory:')
  resetCodeBridgeTablesForTests()
})

describe('levett mappa: a kulcs-formatum valtasa nem hozhatja vissza', () => {
  // A MERT ESET. A tulaj 2026-09-12-en levette a `f:\Marveen\...\Fejlesztés`
  // mappat. Masnap a `workspaceKey` atallt `\` -> `/` normalizalasra (a UNC-utak
  // egyeztetese miatt), es a REGI kulccsal tarolt sort az uj kod nem talalta meg
  // -- a felderites ujra beregisztralta a mappat. A tulaj ugy latta, hogy amit
  // levett, az magatol visszajott.
  it('a REGI (backslash-es) kulccsal tarolt sort is levettnek latja', () => {
    const path = 'f:\\Marveen\\Korpás László\\Projektek\\Tőzsde\\Fejlesztés'
    // Kezzel irjuk be a REGI formatumu kulcsot -- pontosan ugy, ahogy a
    // 2026-09-12-es kod tette volna.
    const legacyKey = path.trim().replace(/[\\/]+$/, '').toLowerCase()
    expect(legacyKey).toContain('\\') // tenyleg a regi alak
    getDb()
      .prepare(
        `INSERT INTO code_dismissed (workspace_key, workspace_path, project, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(legacyKey, path, 'fejlesztes', Date.now())

    // A migracio az ensureTables-ben fut; ez ujra lefuttatja.
    resetCodeBridgeTablesForTests()

    expect(isDismissedWorkspace(path)).toBe(true)
  })

  it('a most levett mappa is levett marad (nem regresszio)', () => {
    const path = 'F:\\Projects\\Alpha'
    dismissCodeWorkspace(path, 'alpha')
    expect(isDismissedWorkspace(path)).toBe(true)
    // Ugyanaz a hely mashogy irva is levettnek szamit.
    expect(isDismissedWorkspace('f:/projects/alpha/')).toBe(true)
  })
})

describe('kituzott sor: a tu a BESZELGETEST vedi, nem a mert adatot', () => {
  // A MERT ESET. A `marveen` sor kituzott volt, es emiatt a felderites MINDEN
  // mezojet eldobta: a cim/host/mtime `null` maradt, az `updated_at` 10 oraja
  // allt, mikozben a beszelgetes epp futott. A kartyan ezert latszott ures cim,
  // es ezert kapta a tulaj a MASIK projekt beszelgeteseit ott, ahol a sajatjait
  // varta (minden "legutobb aktiv" valasztas a frissebb sort preferalja).
  const WS = '\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen'
  const PINNED_SESSION = 'aaaaaaaa-0000-4000-8000-000000000001'

  it('a mert mezok frissulnek, a session_id NEM valtozik', () => {
    upsertCodeSession({ project: 'marveen', workspacePath: WS, sessionId: PINNED_SESSION, pinned: true })

    const before = getCodeSession('marveen')!
    expect(before.pinned).toBe(true)
    expect(before.title).toBeNull()

    // A felderites egy MASIK beszelgetest lat ugyanabban a mappaban, friss
    // adatokkal.
    upsertCodeSession(
      {
        project: 'marveen',
        workspacePath: WS,
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
        title: 'Session azonosito es atirat-fajl',
        host: 'DESKTOP-G1R2RIN',
        transcriptMtime: 1789263000000,
      },
      { fromDiscovery: true },
    )

    const after = getCodeSession('marveen')!
    // A TU TART: a beszelgetes nem vandorolt at.
    expect(after.sessionId).toBe(PINNED_SESSION)
    expect(after.pinned).toBe(true)
    // A MERES ATMEGY: a kartya mar nem "nem latok oda"-t mutat.
    expect(after.title).toBe('Session azonosito es atirat-fajl')
    expect(after.host).toBe('DESKTOP-G1R2RIN')
    expect(after.transcriptMtime).toBe(1789263000000)
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
  })

  it('MASIK mappa jelentese a kituzott sort nem irja at', () => {
    upsertCodeSession({ project: 'marveen', workspacePath: WS, sessionId: PINNED_SESSION, pinned: true })
    upsertCodeSession(
      { project: 'marveen', workspacePath: 'F:\\Egeszen\\Mas', sessionId: 'cccccccc-0000-4000-8000-000000000003', title: 'idegen' },
      { fromDiscovery: true },
    )
    const after = getCodeSession('marveen')!
    expect(after.sessionId).toBe(PINNED_SESSION)
    expect(after.title).toBeNull()
    expect(sameWorkspace(after.workspacePath, WS)).toBe(true)
  })

  it('az EGY- es KET-backslash-es UNC ugyanaz a hely (a bekotes igy frissul)', () => {
    // A tulaj kezzel EGY backslash-sal kotott be; a worker KETTOVEL jelent.
    upsertCodeSession({ project: 'marveen', workspacePath: '\\wsl.localhost\\Ubuntu\\home\\boss\\marveen', sessionId: PINNED_SESSION, pinned: true })
    upsertCodeSession(
      { project: 'marveen', workspacePath: WS, sessionId: PINNED_SESSION, title: 'megjott', host: 'DESKTOP-G1R2RIN' },
      { fromDiscovery: true },
    )
    expect(getCodeSession('marveen')!.title).toBe('megjott')
  })
})

describe('a flotta sajat agens-mappai nem projektek', () => {
  // A MERT ESET. A WSL-felderites bekapcsolasa utan mind a hat flotta-agens
  // munkakonyvtara bekerult a projektlistaba. Tulaj, 2026-09-13: "viszont a
  // csomo agent is projektkent van ott".
  it('az agents/<nev> ala eso utat felismeri', () => {
    expect(isUnderAgentsDir(`${AGENTS_BASE_DIR}/gypsy`)).toBe(true)
    expect(isUnderAgentsDir(`${AGENTS_BASE_DIR}/nemotronultra/almappa`)).toBe(true)
  })

  it('MAGAT az agents mappat es a rajta kivulit nem', () => {
    expect(isUnderAgentsDir(AGENTS_BASE_DIR)).toBe(false)
    expect(isUnderAgentsDir('/home/boss/marveen')).toBe(false)
    expect(isUnderAgentsDir('F:\\Marveen\\Fejlesztes')).toBe(false)
    expect(isUnderAgentsDir('')).toBe(false)
  })

  it('host-agnosztikus: a telepites sajat gyokerebol dolgozik', () => {
    // Nem beegetett ut: ha a telepites mashol all, a bazis is ott all.
    expect(workspaceKey(AGENTS_BASE_DIR).endsWith('/agents')).toBe(true)
  })
})
