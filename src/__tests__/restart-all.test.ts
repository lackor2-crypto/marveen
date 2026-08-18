// "Mindent ujraindit" -- egy gomb, ami minden beallitast eletbe leptet.
//
// Boss, 2026-08-16: "nem lenne sokal egyszerubb ha mindent ujrainditana ami
// letezik a marveen ban? az atyauristent is? ezzel meg lenne oldva a problema
// egyszeruen. nem?"
//
// De -- egyetlen dolgot kiveve, es az nem izlesbeli: a csatorna-szolgaltatas
// alatt el a KOZOS tmux szerver, annak az ujrainditasa MINDEN agens ablakat
// megolne. Ezek a tesztek azt a hatart merik, plusz a masik harom dontest,
// amit egy ujrainditasi sorozatot "kiprobalva" sosem lehetne ellenorizni:
// a SORRENDET, a leallitott agensek kihagyasat, es hogy egy elbukott lepes
// nem allitja meg a tobbit.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRestartAllPlan,
  executeRestartAllPlan,
  SKIP_NOT_RUNNING,
  SKIP_DASHBOARD_UNAVAILABLE,
  type RestartAllInput,
} from '../restart-all.js'

const main = { name: 'marveen', displayName: 'Marvin', running: true, busy: false }
const okDashboard = { possible: true, unit: 'lackor2-bot-dashboard.service', reason: '' }

function input(over: Partial<RestartAllInput> = {}): RestartAllInput {
  return { agents: [], main, dashboard: okDashboard, ...over }
}

describe('buildRestartAllPlan -- sorrend', () => {
  it('a vezerlopult MINDIG az utolso lepes', () => {
    // Az o ujrainditasa oli meg azt a folyamatot, amelyik a tobbit vegrehajtja.
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'lackor3', displayName: 'Segedmunkas', running: true, busy: false },
        { name: 'north', displayName: 'North', running: true, busy: false },
      ],
    }))
    expect(plan.steps[plan.steps.length - 1].kind).toBe('dashboard')
  })

  it('a sub-agensek elobb jonnek, mint a foagens', () => {
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'north', displayName: 'North', running: true, busy: false }],
    }))
    const kinds = plan.steps.map(s => s.kind)
    expect(kinds).toEqual(['agent', 'main-agent', 'dashboard'])
  })

  it('a sub-agensek sorrendje nev szerinti, tehat ket megnyitas kozott nem ugral', () => {
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'north', displayName: 'North', running: true, busy: false },
        { name: 'gypsy', displayName: 'Gypsy', running: true, busy: false },
        { name: 'lackor3', displayName: 'Segedmunkas', running: true, busy: false },
      ],
    }))
    expect(plan.steps.filter(s => s.kind === 'agent').map(s => s.id))
      .toEqual(['gypsy', 'lackor3', 'north'])
  })
})

describe('buildRestartAllPlan -- amit NEM csinalunk', () => {
  it('a leallitott agenst nem inditja EL, es kimondja, miert maradt ki', () => {
    // Aki leallitott egy agenst, az szandekosan tette. Egy "ujrainditas" gomb
    // ne keltsen eletre semmit -- de neman se hagyja ki.
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'gemma', displayName: 'Gemma', running: false, busy: false }],
    }))
    const step = plan.steps.find(s => s.id === 'gemma')!
    expect(step.included).toBe(false)
    expect(step.skipReason).toBe(SKIP_NOT_RUNNING)
  })

  it('a csatorna-unitot SOSEM inditja ujra, meg akkor sem, ha a self-restart engedne', () => {
    // Ez a teszt az egyetlen valodi tiltas orzoje: ha egy telepites osszevonna
    // a vezerlopultot a csatornakkal, inkabb NE induljon ujra semmi, mint hogy
    // a kozos tmux szervert oljuk (vele minden agens ablakat).
    const plan = buildRestartAllPlan(input({
      dashboard: { possible: true, unit: 'lackor2-bot-channels.service', reason: '' },
    }))
    const dash = plan.steps.find(s => s.kind === 'dashboard')!
    expect(dash.included).toBe(false)
    expect(dash.skipReason).toBe(SKIP_DASHBOARD_UNAVAILABLE)
    expect(plan.dashboardPossible).toBe(false)
    expect(plan.dashboardReason).toMatch(/ügynök/)
  })

  it('nem-systemd telepitesen a vezerlopult lepese kimarad, az agensek lepese nem', () => {
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'north', displayName: 'North', running: true, busy: false }],
      dashboard: { possible: false, unit: null, reason: 'Ez a gép nem systemd-vel indítja a Marveent.' },
    }))
    expect(plan.steps.find(s => s.kind === 'dashboard')!.included).toBe(false)
    expect(plan.steps.find(s => s.kind === 'agent')!.included).toBe(true)
    expect(plan.steps.find(s => s.kind === 'main-agent')!.included).toBe(true)
    expect(plan.dashboardReason).toMatch(/systemd/)
  })

  it('a foagens akkor is bekerul, ha eppen nem fut (nala a leallas nem dontes, hanem hiba)', () => {
    const plan = buildRestartAllPlan(input({
      main: { name: 'marveen', displayName: 'Marvin', running: false, busy: false },
    }))
    expect(plan.steps.find(s => s.kind === 'main-agent')!.included).toBe(true)
  })
})

describe('buildRestartAllPlan -- "ki dolgozik eppen"', () => {
  it('csak a tenylegesen megszakitott munkat szamolja', () => {
    // Egy leallitott agens "dolgozik" jelzese elavult olvasat lenne, es
    // feleslegesen ijesztgetne a megerosito ablakban.
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'north', displayName: 'North', running: true, busy: true },
        { name: 'gemma', displayName: 'Gemma', running: false, busy: true },
      ],
    }))
    expect(plan.busyCount).toBe(1)
  })

  it('a foagens munkajat is beleszamolja', () => {
    const plan = buildRestartAllPlan(input({
      main: { name: 'marveen', displayName: 'Marvin', running: true, busy: true },
    }))
    expect(plan.busyCount).toBe(1)
  })
})

describe('executeRestartAllPlan', () => {
  it('a vezerlopultot NEM inditja ujra -- azt a hivo teszi, a valasz kikuldese utan', async () => {
    const plan = buildRestartAllPlan(input())
    const results = await executeRestartAllPlan(plan, {
      restartAgent: () => ({ ok: true }),
      restartMainAgent: () => ({ ok: true }),
      pause: () => Promise.resolve(),
    })
    expect(results.some(r => r.kind === 'dashboard')).toBe(false)
  })

  it('egy elbukott lepes nem allitja meg a sort, es a hiba nem vesz el', async () => {
    // Kulonben egyetlen rossz agens miatt a beallitas SEHOL nem lepne eletbe.
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'a-rossz', displayName: 'Rossz', running: true, busy: false },
        { name: 'b-jo', displayName: 'Jo', running: true, busy: false },
      ],
    }))
    const results = await executeRestartAllPlan(plan, {
      restartAgent: (name) => name === 'a-rossz' ? { ok: false, error: 'tmux nem valaszol' } : { ok: true },
      restartMainAgent: () => ({ ok: true }),
      pause: () => Promise.resolve(),
    })
    expect(results.find(r => r.id === 'a-rossz')).toMatchObject({ ok: false, error: 'tmux nem valaszol' })
    expect(results.find(r => r.id === 'b-jo')!.ok).toBe(true)
    expect(results.find(r => r.kind === 'main-agent')!.ok).toBe(true)
  })

  it('egy kivetelt dobo lepes sem allitja meg a sort', async () => {
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'a-robban', displayName: 'Robban', running: true, busy: false },
        { name: 'b-jo', displayName: 'Jo', running: true, busy: false },
      ],
    }))
    const results = await executeRestartAllPlan(plan, {
      restartAgent: (name) => { if (name === 'a-robban') throw new Error('ENOENT'); return { ok: true } },
      restartMainAgent: () => ({ ok: true }),
      pause: () => Promise.resolve(),
    })
    expect(results.find(r => r.id === 'a-robban')).toMatchObject({ ok: false, error: 'ENOENT' })
    expect(results.find(r => r.id === 'b-jo')!.ok).toBe(true)
  })

  it('a leallitott agenst meg sem probalja elinditani', async () => {
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'gemma', displayName: 'Gemma', running: false, busy: false }],
    }))
    const touched: string[] = []
    const results = await executeRestartAllPlan(plan, {
      restartAgent: (name) => { touched.push(name); return { ok: true } },
      restartMainAgent: () => ({ ok: true }),
      pause: () => Promise.resolve(),
    })
    expect(touched).toEqual([])
    expect(results.find(r => r.id === 'gemma')).toMatchObject({ skipped: true, ok: true })
  })

  it('a vegrehajtas sorrendje a terv sorrendje', async () => {
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'north', displayName: 'North', running: true, busy: false },
        { name: 'gypsy', displayName: 'Gypsy', running: true, busy: false },
      ],
    }))
    const order: string[] = []
    await executeRestartAllPlan(plan, {
      restartAgent: (name) => { order.push(name); return { ok: true } },
      restartMainAgent: () => { order.push('MAIN'); return { ok: true } },
      pause: () => Promise.resolve(),
    })
    expect(order).toEqual(['gypsy', 'north', 'MAIN'])
  })

  // A sorozat kozben a vezerlopultnak VALASZKEPESNEK kell maradnia: egy agens
  // ujrainditasa ~5 masodpercre blokkolja az esemenyhurkot (execSync sleep 2 +
  // sleep 3), es a sajat egeszsegorunk ~40 masodpercnyi nemasag utan
  // ujrainditja a szolgaltatast -- pont a sorozat kozepen. Ezert a lepesek
  // KOZOTT vissza kell adni a vezerlest.
  it('a tenyleges ujrainditasok koze szunetet tesz', async () => {
    const plan = buildRestartAllPlan(input({
      agents: [
        { name: 'a', displayName: 'A', running: true, busy: false },
        { name: 'b', displayName: 'B', running: true, busy: false },
        { name: 'c-all', displayName: 'C', running: false, busy: false },
      ],
    }))
    const trace: string[] = []
    await executeRestartAllPlan(plan, {
      restartAgent: (name) => { trace.push(name); return { ok: true } },
      restartMainAgent: () => { trace.push('MAIN'); return { ok: true } },
      pause: async () => { trace.push('--szunet--') },
    })
    // a + szunet + b + szunet + foagens; a leallitott 'c-all' nem blokkol
    // semmit, ezert ele nem kell szunet
    expect(trace).toEqual(['a', '--szunet--', 'b', '--szunet--', 'MAIN'])
  })

  it('az elso lepes ele nem tesz feleslegesen szunetet', async () => {
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'a', displayName: 'A', running: true, busy: false }],
    }))
    const trace: string[] = []
    await executeRestartAllPlan(plan, {
      restartAgent: (name) => { trace.push(name); return { ok: true } },
      restartMainAgent: () => { trace.push('MAIN'); return { ok: true } },
      pause: async () => { trace.push('--szunet--') },
    })
    expect(trace[0]).toBe('a')
  })
})

// Boss, 2026-08-18: "gondolj arra is ha uj ugynokot veszunk fel azokra is
// ervenyes legyen."
//
// A "mindent ujraindit" akkor er valamit, ha a HOLNAP felvett ugynokre is all,
// anelkul hogy barhol fel kellene venni a nevet. Ezert nem lehet sehol rogzitett
// nevlista: a terv a KERES pillanataban olvassa fel, ki letezik.
describe('uj ugynok kulon lepes nelkul is bekerul', () => {
  it('egy ismeretlen nevu, most keletkezett agens ugyanugy lepes lesz', () => {
    const plan = buildRestartAllPlan(input({
      agents: [{ name: 'vadonatuj', displayName: 'Vadonatúj', running: true, busy: false }],
    }))
    const step = plan.steps.find(s => s.id === 'vadonatuj')
    expect(step, 'az uj agens nem kapott lepest').toBeTruthy()
    expect(step!.included).toBe(true)
  })

  it('barhany agens johet -- a vezerlopult akkor is az utolso', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `agens${String(i).padStart(2, '0')}`,
      displayName: `Agens ${i}`,
      running: true,
      busy: false,
    }))
    const plan = buildRestartAllPlan(input({ agents: many }))
    expect(plan.steps).toHaveLength(42) // 40 + foagens + vezerlopult
    expect(plan.steps[plan.steps.length - 1].kind).toBe('dashboard')
    expect(plan.steps[plan.steps.length - 2].kind).toBe('main-agent')
  })

  it('a kiszolgalo minden hivaskor UJRA olvassa fel az agenseket', () => {
    // Egy bootkor felepitett (es ott ragadt) lista pontosan azt a hibat adna,
    // amit a Boss kizart: az uj agens hianyozna a gombbol, amig a vezerlopult
    // ujra nem indul.
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'system-restart.ts'), 'utf8')
    const snap = route.slice(route.indexOf('function snapshot()'))
    expect(snap).toContain('listAgentNames()')
  })

  it('a megerosito kerdes a tervbol dolgozik, nem sajat nevlistabol', () => {
    const appJs = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
    const fn = appJs.slice(appJs.indexOf('function restartAllConfirmText('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('plan.steps')
  })
})
