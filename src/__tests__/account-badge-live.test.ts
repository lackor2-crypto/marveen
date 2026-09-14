// A kartya jobb felso fiok-jelvenye az ELO bejelentkezett fiokot mutatja, nem
// az agent-id-bol vagy a regiszterbol kepzett fix nevet (Boss, 2026-09-14). Ha
// a valos login elter a rogzitett cimtol (drift) vagy ket elofizetes ul
// ugyanazon a fiokon (collision), a jelveny PIROS -- hogy a rossz fiok azonnal
// latszodjon. Ez a teszt a bongeszo homokozojaban futtatja a `accountBadgeHtml`
// tiszta logikajat, ugyanugy kiszedve a web/app.js-bol, mint az
// agent-card-logout-ui teszt.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() not found in web/app.js`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() is not brace-balanced`)
}

type Row = {
  id: string | null
  isDefault: boolean
  identity: { loggedIn: boolean; email?: string | null }
  identityVerdict?: { kind: string; expected?: string; actual?: string }
}
type Collision = { email: string; ids: (string | null)[] }

function makeBadge(rows: Row[] | null, collisions: Collision[] = [], planLabelCache: Record<string, string> = {}) {
  return new Function(
    't', 'escapeHtml', 'escapeAttr', 'mainAccountLabel', 'stripModelSuffix',
    'providerBadgeLabel', 'primePlanLabels', 'rows', 'collisions', 'planLabelCache',
    `let _claudeAccountRows = rows
     let _claudeIdentityCollisions = collisions
     let _planLabelCache = planLabelCache
     ${extractFn(app, 'emailToAccountLabel')}
     ${extractFn(app, 'liveAccountRowFor')}
     ${extractFn(app, 'accountBadgeHtml')}
     return accountBadgeHtml`,
  )(
    // t() -- a kulcsot es az email/expected/actual parametert visszaadja, hogy
    // a teszt lassa, MELYIK tooltip-kulcs sult ki.
    (k: string, p: Record<string, string> = {}) => `«${k}:${p.email ?? ''}|${p.expected ?? ''}>${p.actual ?? ''}»`,
    (v: string) => String(v),
    (v: string) => String(v),
    () => 'MainFallback',
    (v: string) => String(v),
    (model: string) => (model ? 'PROVIDER:' + model : null),
    () => {},
    rows, collisions, planLabelCache,
  ) as (claudePlan: string | null, isMain: boolean, model?: string, authMode?: string) => string
}

const mainRow = (over: Partial<Row> = {}): Row => ({
  id: null, isDefault: true,
  identity: { loggedIn: true, email: 'lackor2@gmail.com' },
  identityVerdict: { kind: 'ok', actual: 'lackor2@gmail.com' }, ...over,
})
const planRow = (over: Partial<Row> = {}): Row => ({
  id: 'usalackor', isDefault: false,
  identity: { loggedIn: true, email: 'usalackor@gmail.com' },
  identityVerdict: { kind: 'ok', actual: 'usalackor@gmail.com' }, ...over,
})

describe('emailToAccountLabel', () => {
  const label = new Function(`${extractFn(app, 'emailToAccountLabel')} return emailToAccountLabel`)() as (e: string) => string
  it('a cim helyi reszebol kepez emberi nevet', () => {
    expect(label('lackor2@gmail.com')).toBe('Lackor2')
    expect(label('usalackor@gmail.com')).toBe('Usalackor')
  })
  it('ures/hianyzo cimre ures sztring, nem talalgat', () => {
    expect(label('')).toBe('')
    expect(label(null as unknown as string)).toBe('')
  })
})

describe('accountBadgeHtml: ELO login jelvenye', () => {
  it('fo agens: a bejelentkezett cimet mutatja, nem az agent-id-t', () => {
    const html = makeBadge([mainRow()])(null, true)
    expect(html).toContain('Lackor2')
    expect(html).not.toContain('account-badge-drift')
    expect(html).toContain('account_badge_live_tip')
  })

  it('a jelveny KATTINTHATO gomb, a fo agens pin-kulcsa __main__', () => {
    const html = makeBadge([mainRow()])(null, true)
    expect(html).toContain('data-acct-menu')
    expect(html).toContain('data-pin-key="__main__"')
    expect(html).toContain('data-current-email="lackor2@gmail.com"')
    expect(html).toContain('<button')
  })

  it('plan agens gombjanak pin-kulcsa a plan-id', () => {
    const html = makeBadge([planRow()])('usalackor', false)
    expect(html).toContain('data-pin-key="usalackor"')
  })

  it('plan agens: a plan-id szerinti sor elo cimet mutatja', () => {
    const html = makeBadge([planRow()])('usalackor', false, 'claude-opus-5', 'shared')
    expect(html).toContain('Usalackor')
    expect(html).not.toContain('account-badge-drift')
  })

  it('drift: PIROS jelveny a VALODI (actual) fiokkal + figyelmezteto tooltip', () => {
    const html = makeBadge([mainRow({
      identity: { loggedIn: true, email: 'lackor2@gmail.com' },
      identityVerdict: { kind: 'drift', expected: 'usalackor@gmail.com', actual: 'lackor2@gmail.com' },
    })])(null, true)
    expect(html).toContain('account-badge-drift')
    expect(html).toContain('Lackor2')       // a VALODI login, nem a rogzitett
    expect(html).toContain('⚠️')
    expect(html).toContain('account_badge_drift_tip')
  })

  it('collision: PIROS jelveny akkor is, ha a verdict maga ok', () => {
    const html = makeBadge(
      [planRow()],
      [{ email: 'usalackor@gmail.com', ids: ['usalackor'] }],
    )('usalackor', false)
    expect(html).toContain('account-badge-drift')
    expect(html).toContain('account_badge_collision_tip')
  })
})

describe('accountBadgeHtml: visszaeses, ha nincs elo sor', () => {
  it('lista meg nincs meg (null): fo agens a fallback cimke, sose ures', () => {
    const html = makeBadge(null)(null, true)
    expect(html).toContain('MainFallback')
    expect(html).not.toContain('account-badge-drift')
  })

  it('lista meg nincs meg: plan agens a registry-cimke', () => {
    const html = makeBadge(null, [], { usalackor: 'Usalackor' })('usalackor', false)
    expect(html).toContain('Usalackor')
  })

  it('nem Claude-login (nincs sor, nincs plan): a szolgaltato-jelveny', () => {
    const html = makeBadge([])(null, false, 'glm-5.3', 'shared')
    expect(html).toContain('PROVIDER:glm-5.3')
  })

  it('kijelentkezett elo sor: nem allit elo fiokot, a fallbackra esik', () => {
    const html = makeBadge([mainRow({ identity: { loggedIn: false, email: null } })])(null, true)
    expect(html).toContain('MainFallback')
    expect(html).not.toContain('account-badge-drift')
  })
})

function makeMenu(rows: Row[]) {
  return new Function(
    't', 'escapeHtml', 'escapeAttr', 'rows',
    `let _claudeAccountRows = rows
     ${extractFn(app, 'emailToAccountLabel')}
     ${extractFn(app, 'accountMenuHtml')}
     return accountMenuHtml`,
  )(
    (k: string, p: Record<string, string> = {}) => `«${k}:${p.email ?? ''}»`,
    (v: string) => String(v),
    (v: string) => String(v),
    rows,
  ) as (pinKey: string, currentEmail: string) => string
}

describe('accountMenuHtml: a fiok-valaszto menu', () => {
  const rows = [
    mainRow(), // lackor2 (isDefault)
    planRow(), // usalackor
    planRow({ id: 'lackor3', identity: { loggedIn: true, email: 'lackor3@gmail.com' } }),
  ]

  it('minden bejelentkezett fiokot felsorol, duplikatum nelkul', () => {
    const html = makeMenu(rows)('__main__', 'lackor2@gmail.com')
    expect(html).toContain('lackor2@gmail.com')
    expect(html).toContain('usalackor@gmail.com')
    expect(html).toContain('lackor3@gmail.com')
  })

  it('a jelenlegi fiok "pin", a tobbi "switch" muveletet kap', () => {
    const html = makeMenu(rows)('__main__', 'lackor2@gmail.com')
    // a jelenlegi (lackor2) rogzitest kinal, a masik ketto atvaltast
    expect(html).toMatch(/data-acct-action="pin"[^>]*data-email="lackor2@gmail.com"/)
    expect(html).toMatch(/data-acct-action="switch"[^>]*data-email="usalackor@gmail.com"/)
    expect(html).toContain('is-current')
  })

  it('mindig van "masik fiokkal bejelentkezes" tetel', () => {
    const html = makeMenu(rows)('__main__', 'lackor2@gmail.com')
    expect(html).toContain('data-acct-action="login-new"')
  })

  it('ures lista: nem talalgat, kimondja hogy nincs meg fiok', () => {
    const html = makeMenu([])('__main__', '')
    expect(html).toContain('acctmenu.empty')
    expect(html).toContain('data-acct-action="login-new"')
  })
})
