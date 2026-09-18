// Kartya #165 (31f3e26f): a bongeszo-kepesseg tiszta dontesei + a bekotes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sessionHealthFromState, looksLikeLoginUrl, isIrreversibleClick, sessionSlug, normalizeNavigateUrl,
  mapImageClickToViewport,
} from '../browser-logic.js'

describe('mentett munkamenet allapota', () => {
  const now = 1_800_000_000
  it('lejarati ido nelkuli sutik: nem itelunk lejartnak', () => {
    expect(sessionHealthFromState({ cookies: [{ expires: -1 }] }, now)).toBe('ok')
    expect(sessionHealthFromState({ cookies: [] }, now)).toBe('ok')
  })
  it('minden datumozott suti lejart -> expired', () => {
    expect(sessionHealthFromState({ cookies: [{ expires: now - 10 }, { expires: -1 }] }, now)).toBe('expired')
  })
  it('van meg ervenyes suti -> ok', () => {
    expect(sessionHealthFromState({ cookies: [{ expires: now - 10 }, { expires: now + 100 }] }, now)).toBe('ok')
  })
})

describe('belepo-oldal felismerese', () => {
  it('ismert mintak', () => {
    expect(looksLikeLoginUrl('https://bank.hu/login?next=/')).toBe(true)
    expect(looksLikeLoginUrl('https://x.hu/bejelentkezes')).toBe(true)
    expect(looksLikeLoginUrl('https://accounts.example.com/signin/v2')).toBe(true)
    expect(looksLikeLoginUrl('https://x.hu/szamlak')).toBe(false)
    expect(looksLikeLoginUrl('nem url')).toBe(false)
  })
})

describe('visszafordithatatlan kattintas', () => {
  it('fizetes/kuldes/torles feliratok', () => {
    for (const text of ['Fizetés', 'Kifizetés', 'Megrendelem', 'Küldés', 'Elküldöm', 'Törlés', 'Pay now', 'Place order', 'Submit', 'Jóváhagyás']) {
      expect(isIrreversibleClick({ text, tag: 'BUTTON' }), text).toBe(true)
    }
  })
  it('submit tipusu gomb felirattol fuggetlenul', () => {
    expect(isIrreversibleClick({ text: 'Tovább', type: 'submit', tag: 'BUTTON' })).toBe(true)
  })
  it('artalmatlan gomb', () => {
    expect(isIrreversibleClick({ text: 'Tovább', tag: 'A' })).toBe(false)
    expect(isIrreversibleClick({ text: 'Részletek', type: 'button', tag: 'BUTTON' })).toBe(false)
  })
})

describe('bemenetek', () => {
  it('munkamenet-nev', () => {
    expect(sessionSlug('  Teszt Fiók! ')).toBe('teszt-fiok')
    expect(sessionSlug('../../x')).toBe('x')
  })
  it('csak http(s) cimre navigalunk', () => {
    expect(normalizeNavigateUrl('example.com')).toBe('https://example.com/')
    expect(normalizeNavigateUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeNavigateUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeNavigateUrl('')).toBeNull()
  })
})

describe('kepre-kattintas -> viewport koordinata (a5e542ac)', () => {
  it('aranytartoan skalaz: fel meret -> ketszeres koordinata', () => {
    expect(mapImageClickToViewport(100, 50, 640, 360, 1280, 720)).toEqual({ x: 200, y: 100 })
  })
  it('1:1 megjelenites valtozatlanul hagyja', () => {
    expect(mapImageClickToViewport(420, 260, 1280, 720, 1280, 720)).toEqual({ x: 420, y: 260 })
  })
  it('a hatarra eso kattintas nem megy a viewporton kivulre (clamp 0..1)', () => {
    expect(mapImageClickToViewport(700, 400, 640, 360, 1280, 720)).toEqual({ x: 1280, y: 720 })
    expect(mapImageClickToViewport(-10, -10, 640, 360, 1280, 720)).toEqual({ x: 0, y: 0 })
  })
  it('ervenytelen/nulla meret -> null (nem talalgat)', () => {
    expect(mapImageClickToViewport(10, 10, 0, 360, 1280, 720)).toBeNull()
    expect(mapImageClickToViewport(NaN, 10, 640, 360, 1280, 720)).toBeNull()
    expect(mapImageClickToViewport(10, 10, 640, 360, 0, 720)).toBeNull()
  })
})

describe('bekotes', () => {
  const root = process.cwd()
  it('a route a web.ts-ben hivodik', () => {
    const web = readFileSync(join(root, 'src/web.ts'), 'utf8')
    expect(web).toContain("import { tryHandleBrowser } from './web/routes/browser.js'")
    expect(web).toContain('if (await tryHandleBrowser(routeCtx)) return')
  })
  it('az oldal elerheto a menubol es betoltodik', () => {
    const html = readFileSync(join(root, 'web/index.html'), 'utf8')
    const app = readFileSync(join(root, 'web/app.js'), 'utf8')
    expect(html).toContain('data-page="browser"')
    expect(html).toContain('id="browserPage"')
    expect(app).toContain("if (pageId === 'browser') callPageLoader('loadBrowserPage')")
    expect(app).toContain('window.loadBrowserPage = loadBrowserPage')
  })
  it('az ugynok-skill a seed-skills alatt van (a telepito azt masolja)', () => {
    const skill = readFileSync(join(root, 'seed-skills/browser-control/SKILL.md'), 'utf8')
    expect(skill).toContain('/api/browser/navigate')
    expect(skill).toContain('/api/browser/submit')
    expect(skill).toContain('/api/browser/click_xy')
  })
  it('a kepre-kattintas/gepeles akciok a szerveren regisztraltak (a5e542ac)', () => {
    const svc = readFileSync(join(root, 'src/web/browser-service.ts'), 'utf8')
    for (const a of ['click_xy', 'type', 'key', 'scroll']) {
      expect(svc, a).toContain(`'${a}'`)
      expect(svc, a).toContain(`case '${a}'`)
    }
    expect(svc).toContain('page.mouse.click')
    expect(svc).toContain('page.keyboard.type')
  })
  it('a frontend a kepre-kattintast es a gepelest bekoti (a5e542ac)', () => {
    const app = readFileSync(join(root, 'web/app.js'), 'utf8')
    const html = readFileSync(join(root, 'web/index.html'), 'utf8')
    expect(app).toContain("runBrowserUiAction('click_xy'")
    expect(app).toContain("runBrowserUiAction('type'")
    expect(app).toContain("runBrowserUiAction('key'")
    expect(html).toContain('id="browserTypeInput"')
    expect(html).toContain('id="browserTypeBtn"')
  })
})
