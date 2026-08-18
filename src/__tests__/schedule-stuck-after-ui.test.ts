import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Boss, 2026-08-15: "[...] ez mindig megjelenik a telegramban. kell ez nekem?
// [...] nem lehet ezt kikapcsolni? vagy feljebb alitani?"
//
// Measured: store/dashboard.log carries exactly one `task-timeout Telegram
// alert sent` entry, task="memoria-heartbeat", ageMinutes=5 -- i.e. the task
// legitimately runs past the 5-minute DEFAULT threshold, and the alert is
// working as designed. The threshold was already per-task configurable
// (resolveStuckTimeoutMs reads stuckAfterMinutes), but ONLY by hand-editing
// task-config.json: neither the form nor the route knew the field. The alert
// text even instructed the operator to go edit JSON -- not something the
// bricklayer this dashboard is built for can do.
//
// So: the field is now on the Ütemezések form, the route accepts and bounds
// it, and empty means "back to the default" rather than a stored zero.
//
// A temp HOME-ot vi.hoisted-del kell szamolni: a vi.mock hivas a fajl tetejere
// kerul, egy sima const meg TDZ-be futna a gyar belsejeben.
const HOME = vi.hoisted(() => `/tmp/stuck-after-${process.pid}-${Date.now()}`)
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return { ...real, homedir: () => HOME, default: { ...real, homedir: () => HOME } }
})

const { writeScheduledTask, readScheduledTask, SCHEDULED_TASKS_DIR } =
  await import('../web/scheduled-tasks-io.js')
const { validateStuckAfterMinutes, MAX_STUCK_AFTER_MINUTES } =
  await import('../web/routes/schedules.js')

afterAll(() => { rmSync(HOME, { recursive: true, force: true }) })

const PROJECT_ROOT = join(import.meta.dirname, '..', '..')
const app = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf8')
const html = readFileSync(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')

describe('validateStuckAfterMinutes', () => {
  it('atengedi a hianyzo erteket -- a mezo opcionalis', () => {
    expect(validateStuckAfterMinutes(undefined)).toBeNull()
    expect(validateStuckAfterMinutes(null)).toBeNull()
  })

  it('a 0 ervenyes: ez a "vissza az alapertelmezetthez"', () => {
    expect(validateStuckAfterMinutes(0)).toBeNull()
  })

  it('atengedi az ertelmes perceket', () => {
    expect(validateStuckAfterMinutes(1)).toBeNull()
    expect(validateStuckAfterMinutes(20)).toBeNull()
    expect(validateStuckAfterMinutes(MAX_STUCK_AFTER_MINUTES)).toBeNull()
  })

  it('elutasitja a plafon folottit -- ott a riasztas csendben kikapcsolna', () => {
    expect(validateStuckAfterMinutes(MAX_STUCK_AFTER_MINUTES + 1)).toBeTruthy()
    expect(validateStuckAfterMinutes(10_000)).toBeTruthy()
  })

  it('elutasitja a negativot es a nem-szamot', () => {
    expect(validateStuckAfterMinutes(-1)).toBeTruthy()
    expect(validateStuckAfterMinutes(NaN)).toBeTruthy()
    expect(validateStuckAfterMinutes(Infinity)).toBeTruthy()
    expect(validateStuckAfterMinutes('20')).toBeTruthy()
    expect(validateStuckAfterMinutes({})).toBeTruthy()
  })

  it('a plafon egybeesik a kovetes hatarával (6 ora)', () => {
    expect(MAX_STUCK_AFTER_MINUTES).toBe(360)
  })
})

describe('a kuszob mentese', () => {
  const NAME = 'stuck-proba'
  const cfgPath = () => join(SCHEDULED_TASKS_DIR, NAME, 'task-config.json')

  beforeEach(() => {
    rmSync(join(SCHEDULED_TASKS_DIR, NAME), { recursive: true, force: true })
    writeScheduledTask(NAME, { description: 'proba', prompt: 'x', schedule: '0 * * * *' })
  })

  it('a mock valoban a temp home-ba mutat (kulonben az elo configot irnank)', () => {
    expect(SCHEDULED_TASKS_DIR.startsWith(HOME)).toBe(true)
    expect(existsSync(cfgPath())).toBe(true)
  })

  it('a pozitiv erteket kiirja', () => {
    writeScheduledTask(NAME, { stuckAfterMinutes: 20 })
    expect(JSON.parse(readFileSync(cfgPath(), 'utf8')).stuckAfterMinutes).toBe(20)
    expect(readScheduledTask(NAME)?.stuckAfterMinutes).toBe(20)
  })

  it('a 0 TORLI a kulcsot, nem 0-t ir bele', () => {
    writeScheduledTask(NAME, { stuckAfterMinutes: 20 })
    writeScheduledTask(NAME, { stuckAfterMinutes: 0 })
    const raw = JSON.parse(readFileSync(cfgPath(), 'utf8'))
    expect('stuckAfterMinutes' in raw).toBe(false)
    expect(readScheduledTask(NAME)?.stuckAfterMinutes).toBeUndefined()
  })

  it('egy masik mezo mentese nem torli a beallitott kuszobot', () => {
    writeScheduledTask(NAME, { stuckAfterMinutes: 20 })
    writeScheduledTask(NAME, { description: 'mas leiras' })
    expect(readScheduledTask(NAME)?.stuckAfterMinutes).toBe(20)
  })
})

describe('az Utemezesek urlap', () => {
  it('van szammezo a kuszobnek', () => {
    expect(html).toMatch(/id="scheduleStuckAfter"[^>]*type="number"|type="number"[^>]*id="scheduleStuckAfter"/)
  })

  it('a form uritese a kuszobot is uriti', () => {
    expect(app).toMatch(/getElementById\('scheduleStuckAfter'\)\.value = ''/)
  })

  it('szerkeszteskor visszatolti -- de a 0/hianyzo ertek uresen marad', () => {
    expect(app).toMatch(/task\.stuckAfterMinutes > 0 \? task\.stuckAfterMinutes : ''/)
  })

  it('mentesnel az ures mezo 0-kent megy ki (= torles), nem marad ki', () => {
    expect(app).toMatch(/stuckRaw === '' \? 0 : Number\(stuckRaw\)/)
    expect(app).toMatch(/const advanced = \{ skipIfBusy, forceSend, stuckAfterMinutes \}/)
  })

  it('a kliens is hatarol, hogy ne nyers 400-at lasson a felhasznalo', () => {
    expect(app).toMatch(/stuckAfterMinutes < 0 \|\| stuckAfterMinutes > 360/)
    expect(app).toMatch(/tasks\.toast\.stuck_after_range/)
  })

  for (const lang of ['hu', 'en']) {
    it(`${lang}: megvan mind a negy uj forditas`, () => {
      const src = readFileSync(join(PROJECT_ROOT, 'web', 'lang', `${lang}.js`), 'utf8')
      for (const key of ['tasks.modal.stuck_after_label', 'tasks.modal.stuck_after_ph',
        'tasks.modal.stuck_after_hint', 'tasks.toast.stuck_after_range']) {
        const m = new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*'([^']*)'`).exec(src)
        expect(m, `${lang}: hianyzik a(z) ${key}`).toBeTruthy()
        expect(m![1].length).toBeGreaterThan(0)
      }
    })
  }
})

describe('a /api/schedules utvonal', () => {
  const route = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'routes', 'schedules.ts'), 'utf8')

  it('letrehozaskor is tovabbadja a kuszobot, nem csak szerkeszteskor', () => {
    expect(route).toMatch(/stuckAfterMinutes: data\.stuckAfterMinutes/)
  })

  it('mindket bemeneti ponton validal (POST es PUT)', () => {
    expect(route.match(/validateStuckAfterMinutes\(data\.stuckAfterMinutes\)/g)?.length).toBe(2)
    expect(route.match(/if \(stuckErr\) \{ json\(res, \{ error: stuckErr \}, 400\); return true \}/g)?.length).toBe(2)
  })
})

describe('a riasztas szovege', () => {
  const runner = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'schedule-runner.ts'), 'utf8')

  it('a dashboardra kuldi a felhasznalot, nem a task-config.json-hoz', () => {
    const alert = /const text = \[[\s\S]*?\]\.join\('\\n'\)/.exec(runner)?.[0] ?? ''
    expect(alert.length, 'nem talaltam meg a riasztas szoveget').toBeGreaterThan(50)
    expect(alert).toContain('Ütemezések')
    expect(alert).not.toContain('task-config.json')
  })

  it('tovabbra is kimondja a sajat kuszobet -- e nelkul nem tudni, mit kell emelni', () => {
    expect(runner).toMatch(/\$\{thresholdMinutes\} perc/)
  })
})
