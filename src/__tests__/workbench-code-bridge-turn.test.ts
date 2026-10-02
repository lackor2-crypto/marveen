import { describe, it, expect, vi } from 'vitest'
import {
  runCodeBridgeTurn, buildCodeBridgePrompt, codeBridgeErrorDetail, CODE_BRIDGE_HISTORY_TURNS, COMPLETION_MARKER,
  type CodeBridgeTurnDeps, type CodeBridgeTaskView, type CodeBridgeStatus,
} from '../workbench-agent/code-bridge-turn.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'
import { PROMPT_MAX_CHARS } from '../web/code-bridge-store.js'
import { createTranscriptToolFeed } from '../workbench-agent/code-bridge-tool-feed.js'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A generator osszes esemenye egy tombbe. */
async function collect(gen: AsyncGenerator<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/** Fake ora, ami minden sleep-nel elorehalad -- igy a timeout determinisztikus. */
function fakeClock(stepMs: number): { now(): number; sleep(ms: number): Promise<void> } {
  let t = 0
  return {
    now: () => t,
    sleep: async () => { t += stepMs },
  }
}

/** Fake feladatsor: statuszok listaja, minden getTask a kovetkezot adja. */
function fakeTasks(states: CodeBridgeTaskView[]): { getTask(): CodeBridgeTaskView | null } {
  let i = 0
  return {
    getTask: () => {
      const s = states[Math.min(i, states.length - 1)] ?? null
      i++
      return s
    },
  }
}

const task = (status: CodeBridgeStatus, extra: Partial<CodeBridgeTaskView> = {}): CodeBridgeTaskView => {
  const t: CodeBridgeTaskView = { status, result: null, summary: null, error: null, ...extra }
  // Boss, 2026-10-02: a 'done' fixtura egy SIKERES, TELJESEN kesz futast jelent,
  // ezert hordozza a teljes-kesz markert (hacsak mar benne van vagy ures a result).
  if (status === 'done' && typeof t.result === 'string' && t.result.trim() && !t.result.includes(COMPLETION_MARKER)) {
    t.result = `${t.result} ${COMPLETION_MARKER}`
  }
  return t
}

const baseInput = { projectRef: 'p1', message: 'olvasd el a fajlt', lang: 'hu' as const, requestedBy: 'boss' }

describe('runCodeBridgeTurn -- Munkapad chat a kod-hidon (#433, B opcio)', () => {
  it('sikeres futas: atadas -> fut -> kesz, a result szovegkent jon vissza', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('queued'), task('running'), task('done', { result: 'Kesz, elolvastam az egeszet.' })])
    const deps: CodeBridgeTurnDeps = {
      enqueue: () => ({ ok: true, id: 'task-1' }),
      getTask: tasks.getTask,
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 10,
    }
    const evs = await collect(runCodeBridgeTurn(baseInput, deps))
    const types = evs.map((e) => e.type)
    expect(types).toContain('notice') // handed_off
    expect(evs.find((e) => e.type === 'notice')).toMatchObject({ code: 'code_bridge_handed_off' })
    const text = evs.find((e) => e.type === 'text') as Extract<OrchestratorEvent, { type: 'text' }> | undefined
    expect(text?.text).toBe('Kesz, elolvastam az egeszet.')
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('ures valasz: kesz, de nincs result -> nem hallgat el, notice megy', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('done', { result: `   ${COMPLETION_MARKER}`, summary: '' })])
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'text')).toBe(false)
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_done_empty')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('hiba: a feladat error -> a tenyleges hibaszoveg megy ki (nem talalgatunk)', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('error', { error: 'tsc failed: 3 errors' })])
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    const err = evs.find((e) => e.type === 'error') as Extract<OrchestratorEvent, { type: 'error' }> | undefined
    expect(err?.message).toContain('tsc failed: 3 errors')
    expect(evs.some((e) => e.type === 'done')).toBe(false) // error zar, nincs kulon done
  })

  it('enqueue-hiba: a chat nem hal meg, notice + done', async () => {
    const clock = fakeClock(1000)
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: false, message: 'nincs elerheto session' }),
      getTask: () => null, now: clock.now, sleep: clock.sleep,
    }))
    const notice = evs.find((e) => e.type === 'notice') as Extract<OrchestratorEvent, { type: 'notice' }> | undefined
    expect(notice?.code).toBe('code_bridge_enqueue_failed')
    expect(notice?.message).toContain('nincs elerheto session')
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('megszakitas: abort utan cancelled notice + done, nem var tovabb', async () => {
    const clock = fakeClock(1000)
    const ac = new AbortController()
    ac.abort()
    const tasks = fakeTasks([task('running')])
    const evs = await collect(runCodeBridgeTurn({ ...baseInput, signal: ac.signal }, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_cancelled')).toBe(true)
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  // Boss, 2026-09-29: "ne mutassa nekem itt hogy kesz ha meg nincs keszen".
  // A varakozas lejarta NEM kesz: se zold pipa, se `done` -- a felulet a
  // szervert kerdezi, ami a meg futo feladat miatt "fut"-ot mond.
  it('idotullepes: sokaig fut -> timeout notice, de NEM kesz (se done, se ok-pipa)', async () => {
    const clock = fakeClock(60_000) // minden poll +1 perc
    const tasks = fakeTasks([task('running')]) // sosem fejezodik be
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
      pollMs: 1, timeoutMs: 5 * 60_000,
    }))
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_timeout')).toBe(true)
    expect(evs.some((e) => e.type === 'done')).toBe(false)
    expect(evs.some((e) => e.type === 'tool' && (e as { status: string }).status === 'ok')).toBe(false)
  })

  it('elveszett feladat: getTask null futas kozben -> error, nem vegtelen ciklus', async () => {
    const clock = fakeClock(1000)
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: () => null, now: clock.now, sleep: clock.sleep,
    }))
    expect(evs.some((e) => e.type === 'error' && (e as { code: string }).code === 'code_bridge_lost')).toBe(true)
  })
})

describe('#433: a teljes erteku mod a BESZELGETES resze (2026-09-28, merve)', () => {
  // Valos eset: a tulajdonos azt irta a chatbe, "na most meg tudod csinalni?",
  // es a kod-hid CSAK ezt a mondatot kapta -- se elozmeny, se projekt, se
  // munkadarab. A fordulo ráadásul nem kerult a beszelgetesbe, es a hiba oka
  // ("session limit") helyett csak "Claude Code reported an error" latszott.

  it('a feladat a beszelgetes vegevel, a projekttel es a mappaval indul, a vegen az UJ uzenettel', () => {
    const prompt = buildCodeBridgePrompt({
      projectName: 'Iroda fejlesztese',
      projectFolder: '/mnt/f/Marveen/Projektek/Iroda',
      workItem: { title: 'Vélemény az MD-tervről', type: 'document' },
      history: [
        { role: 'user', content: 'Véleményezd a Marvin_Workbench_implementacios_terv.md-t' },
        { role: 'assistant', content: 'A 6-8. fejezetet nem láttam.' },
        { role: 'system', content: 'belso rendszer-sor, nem kell' },
      ],
      message: 'na most meg tudod csinalni?',
      lang: 'hu',
    })
    expect(prompt).toContain('Iroda fejlesztese')
    expect(prompt).toContain('/mnt/f/Marveen/Projektek/Iroda')
    expect(prompt).toContain('Vélemény az MD-tervről')
    expect(prompt).toContain('OWNER: Véleményezd a Marvin_Workbench_implementacios_terv.md-t')
    expect(prompt).toContain('ASSISTANT: A 6-8. fejezetet nem láttam.')
    expect(prompt).not.toContain('belso rendszer-sor')
    expect(prompt).toContain('Hungarian')
    // Az uj uzenet a VEGEN all, az elozmeny utan.
    expect(prompt.trimEnd().endsWith('na most meg tudod csinalni?')).toBe(true)
    expect(prompt.indexOf('OWNER: Véleményezd')).toBeLessThan(prompt.indexOf('na most meg tudod'))
  })

  it('mappa es munkadarab nelkul is kimondja, hogy nincs (nem hallgat rola)', () => {
    const prompt = buildCodeBridgePrompt({ projectName: 'P', projectFolder: null, workItem: null, history: [], message: 'szia', lang: 'en' })
    expect(prompt).toContain('no folder set')
    expect(prompt).toContain('project-level chat')
    expect(prompt).toContain('No earlier messages')
    expect(prompt).toContain('English')
  })

  it('hosszu elozmenyt korlatoz: a LEGUJABB fordulok maradnak, a levagott uzenet jelolve', () => {
    const history = Array.from({ length: CODE_BRIDGE_HISTORY_TURNS + 5 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `uzenet-${i} ` + 'x'.repeat(i === CODE_BRIDGE_HISTORY_TURNS + 4 ? 9000 : 10) }))
    const prompt = buildCodeBridgePrompt({ projectName: 'P', projectFolder: null, workItem: null, history, message: 'uj', lang: 'hu' })
    expect(prompt).not.toContain('uzenet-0 ')
    expect(prompt).toContain(`uzenet-${CODE_BRIDGE_HISTORY_TURNS + 4} `)
    expect(prompt).toContain('shortened here only')
  })

  // #434 (Boss, TG 1764): "Nem sikerult atadni a teljes erteku ugynoknek:
  // prompt too long (12187 > 12000)" -- a hosszu beszelgetes utan MINDEN uzenet
  // elhasalt, mert az elozmeny-keret nagyobb volt, mint a kod-hid felso hatara.
  it('#434: hosszu beszelgetes utan is belefer a kod-hid hataraba, a legujabb fordulo megmarad', () => {
    const history = Array.from({ length: CODE_BRIDGE_HISTORY_TURNS }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fordulo-${i} ` + 'y'.repeat(3990) }))
    const message = 'olvasd el vegig a md dokot es velemenyezd! ' + 'z'.repeat(600)
    const prompt = buildCodeBridgePrompt({ projectName: 'Iroda fejlesztese', projectFolder: '/x/y', workItem: { title: 'terv.md', type: 'doc' }, history, message, lang: 'hu' })
    expect(prompt.trim().length).toBeLessThanOrEqual(PROMPT_MAX_CHARS)
    expect(prompt).toContain(`fordulo-${CODE_BRIDGE_HISTORY_TURNS - 1} `)
    expect(prompt.endsWith(message)).toBe(true)
  })

  it('a kerdes es a valasz a beszelgetes-naploba kerul; a kod-hid a kontextusos feladatot kapja', async () => {
    const clock = fakeClock(1000)
    const recorded: [string, string][] = []
    let enqueued = ''
    const evs = await collect(runCodeBridgeTurn({ ...baseInput, prompt: 'KONTEXTUS + olvasd el a fajlt' }, {
      enqueue: (i) => { enqueued = i.prompt; return { ok: true, id: 't' } },
      getTask: fakeTasks([task('running'), task('done', { result: 'Kesz.' })]).getTask,
      now: clock.now, sleep: clock.sleep,
      record: (role, content) => { recorded.push([role, content]) },
    }))
    expect(enqueued).toBe('KONTEXTUS + olvasd el a fajlt')
    expect(recorded).toEqual([['user', 'olvasd el a fajlt'], ['assistant', 'Kesz.']])
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('a hiba VALODI oka latszik (session limit), nem csak az altalanos "reported an error"', async () => {
    const t = task('error', { error: 'Claude Code reported an error', result: "You've hit your session limit · resets 2:10am (Europe/Budapest)" })
    expect(codeBridgeErrorDetail(t)).toBe("Claude Code reported an error: You've hit your session limit · resets 2:10am (Europe/Budapest)")
    const clock = fakeClock(1000)
    const recorded: [string, string][] = []
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: fakeTasks([t]).getTask, now: clock.now, sleep: clock.sleep,
      record: (role, content) => { recorded.push([role, content]) },
    }))
    const err = evs.find((e) => e.type === 'error') as Extract<OrchestratorEvent, { type: 'error' }>
    expect(err.message).toContain('session limit')
    expect(recorded.at(-1)?.[0]).toBe('system')
    expect(recorded.at(-1)?.[1]).toContain('session limit')
  })

  it('Leallitas: a feladatot a sorban is lezarja, es a naploba is bekerul', async () => {
    const clock = fakeClock(1000)
    const ac = new AbortController()
    ac.abort()
    const cancelled: string[] = []
    const recorded: string[] = []
    await collect(runCodeBridgeTurn({ ...baseInput, signal: ac.signal }, {
      enqueue: () => ({ ok: true, id: 'task-9' }), getTask: fakeTasks([task('running')]).getTask, now: clock.now, sleep: clock.sleep,
      cancel: (id) => { cancelled.push(id) },
      record: (role) => { recorded.push(role) },
    }))
    expect(cancelled).toEqual(['task-9'])
    expect(recorded).toEqual(['user', 'system'])
  })

  it('a chat varakozasa utan kesve erkezo valasz IS a beszelgetesbe kerul (hatterben figyeli)', async () => {
    const clock = fakeClock(60_000)
    const recorded: [string, string][] = []
    // Az elso 7 lekerdezes "fut", utana kesz: a chat 5 percnel mar nem var.
    const states = [...Array.from({ length: 7 }, () => task('running')), task('done', { result: 'Kesve, de kesz.' })]
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: fakeTasks(states).getTask, now: clock.now, sleep: clock.sleep,
      pollMs: 1, timeoutMs: 5 * 60_000, backgroundMs: 60 * 60_000,
      record: (role, content) => { recorded.push([role, content]) },
    }))
    expect(evs.some((e) => e.type === 'notice' && (e as { code: string }).code === 'code_bridge_timeout')).toBe(true)
    await vi.waitFor(() => expect(recorded.some(([r, c]) => r === 'assistant' && c === 'Kesve, de kesz.')).toBe(true))
  })
})

describe('#434: a kod-hid eszkozfutasai egyenkent latszanak (Boss, 2026-09-29, "A")', () => {
  const row = (ts: string, type: 'assistant' | 'user', content: unknown[]): string =>
    JSON.stringify({ type, timestamp: ts, message: { role: type, content } })

  it('a transzkript uj tool_use/tool_result sorai Parancsfutas-esemenyek lesznek, a regiek nem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-feed-'))
    const p = join(dir, 'x.jsonl')
    const start = Date.parse('2026-09-29T10:00:00Z')
    writeFileSync(p, [
      row('2026-09-29T09:00:00Z', 'assistant', [{ type: 'tool_use', id: 'old', name: 'Read', input: { file_path: '/regi.md' } }]),
      row('2026-09-29T10:00:01Z', 'assistant', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/terv.md' } }]),
      '',
    ].join('\n'))
    const feed = createTranscriptToolFeed(start)
    expect(feed.read(p)).toEqual([{ type: 'tool', name: 'Read', status: 'running', detail: '/p/terv.md' }])
    // Felig irt sor: a kovetkezo korig var, nem vesz el.
    const done = row('2026-09-29T10:00:02Z', 'user', [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }])
    appendFileSync(p, done.slice(0, 20))
    expect(feed.read(p)).toEqual([])
    appendFileSync(p, done.slice(20) + '\n'
      + row('2026-09-29T10:00:03Z', 'assistant', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test', description: 'Tesztek' } }]) + '\n')
    expect(feed.read(p)).toEqual([
      { type: 'tool', name: 'Read', status: 'ok' },
      { type: 'tool', name: 'Bash', status: 'running', detail: 'Tesztek' },
    ])
    // A feladat vege lezarja a nyitva maradt futast, hogy ne porogjon orokke.
    expect(feed.read(p, 'error')).toEqual([{ type: 'tool', name: 'Bash', status: 'error' }])
    rmSync(dir, { recursive: true, force: true })
  })

  it('a fordulo a futas kozben es a vegen is kiadja a toolRuns esemenyeit', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('running'), task('done', { result: 'Kesz.' })])
    const calls: Array<string | undefined> = []
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't9' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
      toolRuns: (id, finish) => {
        calls.push(finish)
        expect(id).toBe('t9')
        return finish ? [{ type: 'tool', name: 'Edit', status: finish }] : [{ type: 'tool', name: 'Edit', status: 'running', detail: '/a.ts' }]
      },
    }))
    expect(calls).toEqual([undefined, 'ok'])
    const tools = evs.filter((e) => e.type === 'tool').map((e) => `${(e as { name: string }).name}:${(e as { status: string }).status}`)
    expect(tools).toEqual(['code-bridge:running', 'Edit:running', 'Edit:ok', 'code-bridge:ok'])
    expect(evs.at(-1)).toMatchObject({ type: 'done' })
  })

  it('ha a toolRuns eldobja magat, a valasz akkor is megjon', async () => {
    const clock = fakeClock(1000)
    const tasks = fakeTasks([task('running'), task('done', { result: 'Kesz.' })])
    const evs = await collect(runCodeBridgeTurn(baseInput, {
      enqueue: () => ({ ok: true, id: 't' }), getTask: tasks.getTask, now: clock.now, sleep: clock.sleep,
      toolRuns: () => { throw new Error('EACCES') },
    }))
    expect(evs.some((e) => e.type === 'text')).toBe(true)
  })
})

// Boss, 2026-09-29: "tegezo viszonyban beszelj! egesd be a marvinba."
describe('tegezes: a Munkapad magyarul tegezve beszel', () => {
  it('a teljes erteku ugynok promptja magyarul tegezest ker, angolul nem ir ilyet', () => {
    const base = { projectName: 'P', projectFolder: null, workItem: null, history: [], message: 'szia' }
    const hu = buildCodeBridgePrompt({ ...base, lang: 'hu' })
    expect(hu).toContain('Address the owner informally (tegezés')
    expect(hu).toMatch(/never with "Ön" or "Maga"/)
    expect(buildCodeBridgePrompt({ ...base, lang: 'en' })).not.toContain('tegezés')
  })

  it('a projekt-asszisztens rendszer-uzenete is tegezest ir elo', async () => {
    const { SYSTEM_PROMPT } = await import('../workbench-agent/context.js')
    expect(SYSTEM_PROMPT).toMatch(/In Hungarian, address the owner informally \(tegezés/)
  })

  it('a telepito a magyar CLAUDE.md-be is tegezest ir', async () => {
    const { readFileSync } = await import('node:fs')
    const lang = readFileSync(join(__dirname, '..', '..', 'install-lang.sh'), 'utf-8')
    const line = lang.split('\n').find((l) => l.includes('hu:owner_language_line)')) || ''
    expect(line).toContain('tegező viszonyban')
    // A sed "s/.../.../" helyettesitesbe megy: perjel nem lehet benne.
    expect(line.replace(/^.*echo "/, '').replace(/" ;;$/, '')).not.toContain('/')
  })
})

describe('1/A: a teljes erteku ugynok az iratok oldal-szoveget kapja', () => {
  it('ha van irat az anyagok kozott, a prompt megmondja, honnan kerje le oldalankent', () => {
    const prompt = buildCodeBridgePrompt({
      projectName: 'P', projectFolder: '/x', history: [], message: 'mi all a 17. oldalon?', lang: 'hu',
      workItem: { title: 'Level', type: 'note', folder: 'Level', materials: ['Level/level.pdf [readable, 30 page(s)]'], documentsHint: 'Documents ... /document?path=' },
    })
    expect(prompt).toContain('Level/level.pdf [readable, 30 page(s)]')
    expect(prompt).toContain('Documents ... /document?path=')
  })
})

import { claimsPendingWork, codeBridgeFullyDone as fullyDoneForPending } from '../workbench-agent/code-bridge-turn.js'
describe('a befejezes jele mellett kimondott hatralevo munka nem kesz (Boss, 2026-10-02)', () => {
  it('detects pending-work wording in the closing words, Hungarian and English', () => {
    expect(claimsPendingWork('Kesz a resz.\n\nAmi hátravan a tervből: a kijelzés. Ezzel folytatom.\n\n[MINDEN_KESZ]')).toBe(true)
    expect(claimsPendingWork('Done with A. Still to do: B.\n[MINDEN_KESZ]')).toBe(true)
    expect(claimsPendingWork('Mindent elvégeztem, a teszt zöld.\n\n[MINDEN_KESZ]')).toBe(false)
  })
  it('asking the owner which part to do is not finishing (Boss, 2026-10-02)', () => {
    expect(claimsPendingWork('Két dolog maradt. Ezeket nem kezdtem el. Ha folytatni akarod, szólj, melyikkel kezdjem.\n\n[MINDEN_KESZ]')).toBe(true)
    expect(claimsPendingWork('Shall I continue with B?')).toBe(true)
    expect(claimsPendingWork('Mindent elvégeztem, semmi nem maradt ki.\n\n[MINDEN_KESZ]')).toBe(false)
  })
  it('only the tail counts: an early mention in a long report does not cancel the marker', () => {
    const long = 'A következő lépés volt a mentés.' + ' x'.repeat(800) + '\nMinden kész.\n[MINDEN_KESZ]'
    expect(claimsPendingWork(long)).toBe(false)
  })
  it('a done task with the marker but with pending words is not fully done', () => {
    const base = { status: 'done', error: null, summary: null }
    expect(fullyDoneForPending({ ...base, result: 'Kész. [MINDEN_KESZ]' } as never)).toBe(true)
    expect(fullyDoneForPending({ ...base, result: 'Ezzel folytatom. [MINDEN_KESZ]' } as never)).toBe(false)
  })
})
