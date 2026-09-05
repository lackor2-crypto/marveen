// Kanban #202 (231cb999), masodik menet: a koszones-dontes HAROM sebe.
//
// Az elso menet (b5c21c0) a dontesi logikat megirta es le is fedte tesztekkel.
// Egy kesobbi atvizsgalas harom dolgot talalt, amit a zold tesztek nem lattak --
// mindharom arrol szol, hogy a MERES nem er el odaig, ahova a dontes epul:
//
//  1. A dontes bemenete (conversation_log) CSAK a fo agensnel keletkezett: a
//     ledger-hookok a repo sajat .claude/settings.json-jeben alltak, ami a
//     sub-agensekre nem vonatkozik. Merve: 1169 bejovo sor a fo agensnel, 0 minden
//     mas agensnel -- azaz a #202 mindenki masnal orokre 'nem_tudom'-ot adott, es
//     a panaszolt zaj barmikor visszajohetett egy sub-agens sajat csatornajan.
//  2. A varakozas hosszat a LEGFRISSEBB valaszra varo uzenetbol szamolta. Ha a
//     tulajdonos a kieses alatt ujra irt, az 5 oras kieses 2 percnek latszott.
//  3. A paritas-kapu a ket settings.json kozul csak az egyiket olvasta, tehat az
//     1. pont hibaja strukturalisan lathatatlan volt a szamara: zolden allt, mert
//     nem nezett oda -- nem mert nem volt elteres.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideWakeGreeting, GREETING_OUTAGE_AFTER_MS } from '../wake-greeting.js'
import {
  findParityDrift, describeParityDrift, hookScriptNames,
  unionHookScripts, mainAgentSettingsPaths,
} from '../agent-parity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE = join(ROOT, 'templates', 'settings.json.template')
const PROJECT_SETTINGS = join(ROOT, '.claude', 'settings.json')

function hooksOf(path: string): unknown {
  return (JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: unknown }).hooks
}

// ---------------------------------------------------------------- 2. a varakozas

describe('a varakozas a LEGREGEBBI valasz nelkuli uzenettol szamit', () => {
  const now = 1_000_000_000_000

  it('ot ora kieses, amit egy ket perces uzenet elfed -> MEGIS kieses', () => {
    // A tulajdonos ot orayal ezelott kerdezett, valasz nem jott, es a hallgatas
    // miatt ket perce ujra irt ("?"). A regi kod a friss sort nezte, tehat
    // 'folyamatos'-t mondott -- eppen ott hallgatva el az eletjelet, ahol a
    // tulajdonos tenyleg vart ra.
    const d = decideWakeGreeting({
      lastInboundAt: now - 2 * 60_000,
      oldestUnansweredAt: now - 5 * 60 * 60_000,
      answered: false,
      inboundRows: 2,
      readable: true,
    }, now)
    expect(d.verdict).toBe('kieses')
    expect(d.greet).toBe(true)
    expect(d.waitedMs).toBe(5 * 60 * 60_000)
  })

  it('valodi folyamatos beszelgetes tovabbra sem koszon (a #202 eredeti esete)', () => {
    // Egyetlen friss, valaszra varo uzenet: a nyito ES az utolso ugyanaz.
    const d = decideWakeGreeting({
      lastInboundAt: now - 3 * 60_000,
      oldestUnansweredAt: now - 3 * 60_000,
      answered: false,
      inboundRows: 1,
      readable: true,
    }, now)
    expect(d.verdict).toBe('folyamatos')
    expect(d.greet).toBe(false)
  })

  it('a mezo hianyaban a regi viselkedes marad (nem tor el regi hivot)', () => {
    const d = decideWakeGreeting(
      { lastInboundAt: now - GREETING_OUTAGE_AFTER_MS, answered: false, inboundRows: 1, readable: true },
      now,
    )
    expect(d.verdict).toBe('kieses')
  })

  it('jovobeli nyito idobelyeg -> nem talalgat, a biztonsagos ag megy', () => {
    const d = decideWakeGreeting({
      lastInboundAt: now - 60_000,
      oldestUnansweredAt: now + 60_000,
      answered: false,
      inboundRows: 1,
      readable: true,
    }, now)
    expect(d.verdict).toBe('nem_tudom')
    expect(d.greet).toBe(true)
  })
})

describe('getConversationEdge: a legregebbi valaszra varo sor', () => {
  it('a valos tabla-alakon a NYITO uzenetet adja, nem a legfrissebbet', async () => {
    const { default: Database } = await import('better-sqlite3')
    const { initDatabase, getConversationEdge } = await import('../db.js')
    const dir = mkdtempSync(join(tmpdir(), 'wake-oldest-'))
    try {
      const file = join(dir, 'probe.db')
      initDatabase(file)
      const raw = new Database(file)
      const ins = raw.prepare(
        `INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      // Lezart kor: kerdes + valasz.
      ins.run('b1', 'c', 'in', '1', 'regi', '2026-01-01T00:00:00Z', 1000)
      ins.run('b1', 'c', 'out', null, 'valasz', '2026-01-01T00:00:05Z', 1005)
      // Innentol ket valaszra varo kerdes -- a NYITO az 1100-as.
      ins.run('b1', 'c', 'in', '2', 'nyito kerdes', '2026-01-01T00:01:40Z', 1100)
      ins.run('b1', 'c', 'in', '3', '?', '2026-01-01T00:20:00Z', 2200)

      const e = getConversationEdge('b1')
      expect(e.lastInboundAt).toBe(2200 * 1000)
      expect(e.oldestUnansweredAt).toBe(1100 * 1000)
      expect(e.answered).toBe(false)

      // Valasz erkezik -> nincs tobbe nyito kerdes.
      ins.run('b1', 'c', 'out', null, 'itt vagyok', '2026-01-01T00:21:00Z', 2260)
      const after = getConversationEdge('b1')
      expect(after.answered).toBe(true)
      expect(after.oldestUnansweredAt).toBe(null)
      raw.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- 1. a jel maga

describe('a dontes bemenete MINDEN agenshez eljut', () => {
  const templateScripts = hookScriptNames(hooksOf(TEMPLATE))

  it('a sablon hordozza a ledger-hookokat -- enelkul a #202 csak a fo agensnel mukodik', () => {
    // Ez a teszt a #202 legsulyosabb sebe: a dontesi logika hibatlan lehet, ha a
    // bemenete sosem keletkezik. A sablon az EGYETLEN ut, ami minden agenshez
    // elvisz (ensureAgentHooks, visszamenoleg is).
    expect(templateScripts).toContain('ledger-capture.py')
    expect(templateScripts).toContain('ledger-outbound.py')
  })

  it('a replay es a tool-naplo is a flottae, nem csak a fo agense', () => {
    expect(templateScripts).toContain('ledger-replay.py')
    expect(templateScripts).toContain('tool-log-capture.py')
  })

  it('a repo sajat settings-e mar NEM futtatja ujra oket (nincs ketszeres naplozas)', () => {
    // A fo agens mindket fajlt megkapja (user + project scope). A kimeno sor
    // nincs deduplikalva (message_id NULL), tehat egy ottfelejtett masodpeldany
    // minden valaszt ketszer irna be.
    const projectScripts = hookScriptNames(hooksOf(PROJECT_SETTINGS))
    for (const s of ['ledger-capture.py', 'ledger-outbound.py', 'ledger-replay.py', 'tool-log-capture.py']) {
      expect(projectScripts, `${s} maradt a projekt-settingsben`).not.toContain(s)
    }
  })
})

// ---------------------------------------------------------------- 3. a kapu lat

describe('a paritas-kapu MINDKET settings.json-t nezi', () => {
  it('a ket forras a felhasznaloi ES a projekt fajl', () => {
    const paths = mainAgentSettingsPaths('/h', '/repo')
    expect(paths).toEqual(['/h/.claude/settings.json', '/repo/.claude/settings.json'])
  })

  it('az unio egyetlen halmazba hozza a ketto tartalmat', () => {
    const a = { UserPromptSubmit: [{ hooks: [{ command: 'python3 /x/alpha.py' }] }] }
    const b = { Stop: [{ hooks: [{ command: 'python3 /x/beta.py' }] }] }
    expect([...unionHookScripts([a, b])].sort()).toEqual(['alpha.py', 'beta.py'])
  })

  it('a hianyzo/olvashatatlan forras nem dob, csak nem ad hozza semmit', () => {
    expect([...unionHookScripts([null, undefined, 'nem objektum'])]).toEqual([])
  })

  it('ezen a telepitesen a ket fajl EGYUTT sem fut olyat, amit a flotta nem kap', () => {
    const mainSettings = join(homedir(), '.claude', 'settings.json')
    if (!existsSync(mainSettings)) return
    const paths = mainAgentSettingsPaths(homedir(), ROOT).filter(p => existsSync(p))
    const drift = findParityDrift(unionHookScripts(paths.map(hooksOf)), hookScriptNames(hooksOf(TEMPLATE)))
    expect(drift, describeParityDrift(drift)).toEqual([])
  })
})

// ---------------------------------------------------------------- 4. a jel tiszta

describe('a naplot IRO hookok nem talalnak ki agenst', () => {
  const lib = join(ROOT, 'scripts', 'hooks', 'ledger_lib.py')

  /** A fuggvenyt a SAJAT telepitesehez meri: a ledger_lib az install-gyokeret a
   *  sajat fajl-helyebol vezeti le, tehat egy ideiglenes <tmp>/scripts/hooks/
   *  masolat egy teljes, ures telepitest szimulal. Igy a pozitiv ag (valodi
   *  agens-mappa) es a negativ ag (barmi mas) is determinisztikusan merheto --
   *  friss telepitesen es CI-n is, ahol az `agents/` mappa nem letezik. */
  function knownAgentIn(install: string, cwd: string): string {
    const hooks = join(install, 'scripts', 'hooks')
    const r = spawnSync('python3', [
      '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(hooks)});`
      + `import ledger_lib; print(ledger_lib.known_agent_id(${JSON.stringify(cwd)}) or '')`,
    ], { encoding: 'utf-8' })
    return (r.stdout || '').trim()
  }

  function fakeInstall(agentNames: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-install-'))
    mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
    copyFileSync(lib, join(dir, 'scripts', 'hooks', 'ledger_lib.py'))
    for (const n of agentNames) mkdirSync(join(dir, 'agents', n), { recursive: true })
    return dir
  }

  it('valodi agens-mappa -> az agens neve', () => {
    const dir = fakeInstall(['peldaagens'])
    try {
      expect(knownAgentIn(dir, join(dir, 'agents', 'peldaagens'))).toBe('peldaagens')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ismeretlen mappa -> URES (nem talal ki nevet, pl. "store")', () => {
    // Ez a valodi kar: a store/ mappabol indult session harom kimeno sort irt
    // be `store` nevu "agens" ala, amit soha senki nem tudott ertelmezni.
    const dir = fakeInstall(['peldaagens'])
    try {
      expect(knownAgentIn(dir, join(dir, 'store'))).toBe('')
      expect(knownAgentIn(dir, join(dir, 'agents', 'nincs-ilyen'))).toBe('')
      expect(knownAgentIn(dir, '/tmp/valami-nem-agens')).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a fo agens akkor is atmegy, ha nincs neki agents/ almappaja', () => {
    // A fo agens cwd-je maga a telepites gyokere -- neki nincs agents/<id>
    // mappaja, megis o a legfontosabb iro.
    const dir = fakeInstall([])
    try {
      expect(knownAgentIn(dir, dir)).not.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a lib letezik es a fuggveny hivhato', () => {
    expect(existsSync(lib)).toBe(true)
  })

  it('minden IRO hook a szigoru feloldast hasznalja, az OLVASO a megengedot', () => {
    // A hatarvonal: egy rossz OLVASAS semmit nem talal (artalmatlan), egy rossz
    // IRAS viszont bennmarad a tablaban. A replay olvaso, ezert neki kell a
    // megengedo valtozat -- kulonben egy worktree-bol indult session sajat
    // magat sem ismerne fel.
    const hooksDir = join(ROOT, 'scripts', 'hooks')
    for (const f of ['ledger-capture.py', 'ledger-outbound.py', 'tool-log-capture.py']) {
      const src = readFileSync(join(hooksDir, f), 'utf-8')
      expect(src, `${f}: nem a szigoru feloldast hasznalja`).toContain('known_agent_id(')
      expect(src, `${f}: meg mindig kitalalhat agens-nevet`).not.toContain('agent_id_from_cwd(')
    }
    expect(readFileSync(join(hooksDir, 'ledger-replay.py'), 'utf-8')).toContain('agent_id_from_cwd(')
  })
})
