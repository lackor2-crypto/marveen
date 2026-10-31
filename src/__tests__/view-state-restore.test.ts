import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #435 (Boss, TG 1753): "frissiteskor miert nem ugyanaz jon be, ugyanaz az
// utvonal? ... Mindenhol ugyanaz jojjon be, ugyanaz az oldal."
// The URL hash only held the menu page; the position INSIDE the page (open
// project, Workbench, folder, detail view) was lost on every F5.

const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function helperSource(): string {
  const start = APP.indexOf('// === F5 brings back the same view (#435) ===')
  const endMarker = "document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _viewStateSave() })"
  const end = APP.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return APP.slice(start, end + endMarker.length)
}

type Env = { store: Map<string, string>; handlers: Record<string, () => void>; setHash: (h: string) => void }

/** Loads the helper as one "document": a fresh module scope over a shared sessionStorage. */
function loadDoc(env: Env, hash: string, blocked = false) {
  env.setHash(hash)
  const location = { hash, search: '' }
  env.setHash = (h: string) => { location.hash = h }
  const sessionStorage = {
    getItem: (k: string) => { if (blocked) throw new Error('blocked'); return env.store.has(k) ? env.store.get(k)! : null },
    setItem: (k: string, v: string) => { if (blocked) throw new Error('blocked'); env.store.set(k, String(v)) },
    removeItem: (k: string) => { if (blocked) throw new Error('blocked'); env.store.delete(k) },
  }
  const document = { visibilityState: 'visible', addEventListener: (ev: string, fn: () => void) => { env.handlers['doc:' + ev] = fn } }
  const window = { addEventListener: (ev: string, fn: () => void) => { env.handlers['win:' + ev] = fn } }
  const fn = new Function('location', 'sessionStorage', 'document', 'window', 'URLSearchParams',
    helperSource() + '\nreturn { viewStateRegister, viewStateTake, save: _viewStateSave }')
  return fn(location, sessionStorage, document, window, URLSearchParams) as {
    viewStateRegister: (p: string, c: () => unknown) => void
    viewStateTake: (p: string) => unknown
    save: () => void
  }
}

function newEnv(): Env { return { store: new Map(), handlers: {}, setHash: () => {} } }

describe('#435: F5 utan ugyanaz az oldal-belso nezet jon vissza', () => {
  it('a frissites elotti hely (pagehide) az ujratoltott lapon visszajon -- egyszer', () => {
    const env = newEnv()
    const a = loadDoc(env, '#projects')
    a.viewStateRegister('projects', () => ({ current: 'p1', tab: 'files', wb: null }))
    env.handlers['win:pagehide']()
    const b = loadDoc(env, '#projects')
    expect(b.viewStateTake('projects')).toEqual({ current: 'p1', tab: 'files', wb: null })
    // A kesobbi menu-kattintas mar a regi viselkedes: nem ugrik vissza.
    expect(b.viewStateTake('projects')).toBeNull()
  })

  it('a lap elrejtesekor (visibilitychange) is ment -- mobilon ez jon az F5 helyett', () => {
    const env = newEnv()
    const a = loadDoc(env, '#intezo')
    a.viewStateRegister('intezo', () => ({ path: 'Ügyfelek/Kovács' }))
    env.handlers['doc:visibilitychange']()
    // visibilityState 'visible' -> semmi; a mentest a 'hidden' allapot inditja
    expect(env.store.size).toBe(0)
    a.save()
    expect(loadDoc(env, '#intezo').viewStateTake('intezo')).toEqual({ path: 'Ügyfelek/Kovács' })
  })

  it('csak AZ az oldal kapja vissza, amelyiken a frissites tortent', () => {
    const env = newEnv()
    const a = loadDoc(env, '#projects')
    a.viewStateRegister('projects', () => ({ current: 'p1' }))
    a.save()
    // Ha a frissites utan mas oldalra erkezik (pl. kezzel atirt cim), a projekt nem nyilik ki.
    const b = loadDoc(env, '#kanban')
    expect(b.viewStateTake('projects')).toBeNull()
  })

  it('ha az oldalon nincs belso hely (a listan all), a regi mentes torlodik', () => {
    const env = newEnv()
    const a = loadDoc(env, '#projects')
    let current: string | null = 'p1'
    a.viewStateRegister('projects', () => (current ? { current } : null))
    a.save()
    a.viewStateTake('projects') // the page has loaded (and taken what was stored); only then does "no place" delete
    current = null
    a.save()
    expect(env.store.size).toBe(0)
    expect(loadDoc(env, '#projects').viewStateTake('projects')).toBeNull()
  })

  it('tiltott tarolo (privat mod) nem dob hibat, csak nem emlekszik', () => {
    const env = newEnv()
    const a = loadDoc(env, '#projects', true)
    a.viewStateRegister('projects', () => ({ current: 'p1' }))
    expect(() => a.save()).not.toThrow()
    expect(loadDoc(env, '#projects', true).viewStateTake('projects')).toBeNull()
  })

  it('egy dobo gyujto nem akasztja meg az oldal elhagyasat', () => {
    const env = newEnv()
    const a = loadDoc(env, '#docs')
    a.viewStateRegister('docs', () => { throw new Error('boom') })
    expect(() => a.save()).not.toThrow()
  })

  // Minden oldal, ahol a hely eddig frissiteskor elveszett, be van kotve:
  // gyujt (register) ES az elso betolteskor visszaveszi (take).
  it.each(['projects', 'intezo', 'drive', 'megadepot', 'irodaSettings', 'docs'])('%s: menti es visszaveszi a helyet', (page) => {
    expect(APP).toContain(`viewStateRegister('${page}'`)
    expect(APP).toContain(`viewStateTake('${page}')`)
  })

  // Boss, TG 3829: the automatic update reload saves the position ON PURPOSE (a localStorage copy, used once and only
  // when fresh), so the project / work item / panel come back even when the page-close event or the tab store fails.
  it('the automatic update reload writes the position itself and the next load takes it back once', () => {
    expect(APP).toMatch(/async function hardRefresh\(\) \{\s*_viewStateSave\(true\)/)
    expect(APP).toContain("localStorage.setItem(VIEW_AUTO_KEY")
    expect(APP).toContain("localStorage.removeItem(VIEW_AUTO_KEY)")
    expect(APP).toContain('VIEW_AUTO_MAX_AGE_MS')
  })

  // Boss, TG 3843: saving only on page close leaves nothing when the browser drops a background tab. The position is
  // also kept continuously, and read back only on a reload / restored load.
  it('keeps the position continuously and takes it back only on a reload or discarded-tab load', () => {
    expect(APP).toContain("const VIEW_LIVE_KEY = 'marveen.viewStateLive'")
    expect(APP).toContain('setInterval(_viewLiveSave, 3000)')
    expect(APP).toContain('document.wasDiscarded')
    expect(APP).toMatch(/_viewIsReloadLoad\(\)\) \{\s*try \{\s*const live/)
  })

  it('TG 3883: a page left before it finished loading does not delete the stored position', () => {
    const env = newEnv()
    const a = loadDoc(env, '#projects')
    a.viewStateRegister('projects', () => ({ current: 'p1', tab: 'overview', wb: { projectId: 'p1', item: 'w1' } }))
    a.save()
    const b = loadDoc(env, '#projects') // reload: the project page has not run yet, nothing taken, collector empty
    b.viewStateRegister('projects', () => null)
    b.save()
    expect(loadDoc(env, '#projects').viewStateTake('projects')).toEqual({ current: 'p1', tab: 'overview', wb: { projectId: 'p1', item: 'w1' } })
  })

  it('TG 3883: while the restored view is not drawn yet the saved position is the taken one, not a degraded one', () => {
    const src = APP
    const i = src.indexOf('function viewStatePending')
    expect(i).toBeGreaterThan(0)
    expect(src).toContain('function _viewCollect(page)')
    expect(src).toContain("viewStatePending('projects', back)")
    expect(src).toContain("viewStateApplied('projects')")
    // the project load keeps retrying for minutes, and the reload waits for the server to answer first
    expect(src).toContain('i < 60 && _prj.current === openId')
    expect(src).toContain("fetch('/api/app-version', { cache: 'no-store' }); if (r.ok) break")
  })
  it('TG 3900: re-running the current page (reconnect, language switch) keeps the open project; a menu click still opens the list', () => {
    expect(APP).toContain('let _viewKeepNext = false')
    expect(APP).toMatch(/_viewKeepNext = true\s*try \{ switchPage\(active\)/)
    expect(APP).toContain('_viewKeepNext = true; switchPage(pageId); _viewKeepNext = false')
    expect(APP).toContain("const here = _viewKeepNext && _prj.current ? _viewCollect('projects') : null")
    expect(APP).toContain("viewStateTake('projects') || here")
  })
})
