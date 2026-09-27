// Kanban #416 (owner, TG 1681): an English install must get English on the
// owner's channel, a Hungarian install Hungarian. Every owner-facing text is
// picked by the install language -- ol(hu, en) in TS, `ol HU EN` in shell --
// never a bare literal.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ol, ownerLang, uiString } from '../owner-lang.js'

const ROOT = join(__dirname, '..', '..')
const NOTIFY_FNS = [
  'notifyChannel', 'notifyTelegram', 'notifySecurityEvent',
  'sendOwnerChannelChecked', 'sendAlert', 'sendRoutineAlert',
]

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue
      out.push(...tsFiles(p))
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

describe('owner alerts follow the install language', () => {
  it('no owner-notify call is handed a bare string literal', () => {
    const re = new RegExp(`\\b(${NOTIFY_FNS.join('|')})\\(\\s*[\`'"]`)
    const hits: string[] = []
    // scripts/*.ts are owner-facing CLIs too (e.g. dashboard-user security:reset).
    for (const f of [...tsFiles(join(ROOT, 'src')), ...tsFiles(join(ROOT, 'scripts'))]) {
      readFileSync(f, 'utf-8').split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}`)
      })
    }
    expect(hits, 'wrap the text in ol(hu, en) from src/owner-lang.ts').toEqual([])
  })

  it('every owner-alerting shell script loads the language helper', () => {
    const scripts = [
      'cred-switch-watchdog.sh', 'fleet-memory-gate.sh', 'limit-monitor.sh',
      'ratelimit-telegram-alert.sh', 'github-pr-monitor.sh', 'disk-space-guard.sh',
      'stuck-modal-guard.sh', 'subagent-retry.sh', 'modal-question-guard.sh',
      'unit-fail-notify.sh', 'host-restart-watchdog.sh',
    ]
    for (const s of scripts) {
      const src = readFileSync(join(ROOT, 'scripts', s), 'utf-8')
      expect(src, s).toContain('scripts/lib/owner-lang.sh')
    }
  })

  it('ol/ownerLang pick by the install language', () => {
    expect(ownerLang('en-US')).toBe('en')
    expect(ownerLang('hu')).toBe('hu')
    expect(ownerLang('')).toBe('hu')
    expect(ol('szia', 'hi', 'en')).toBe('hi')
    expect(ol('szia', 'hi', 'hu')).toBe('szia')
  })

  it('uiString reuses the dashboard translation, fills params, falls back', () => {
    const p = { project: 'demo' }
    expect(uiString('cb.err.unknown_project', p, 'x', 'en')).toBe('Unknown project: demo')
    expect(uiString('cb.err.unknown_project', p, 'x', 'hu')).toContain('demo')
    expect(uiString('cb.err.unknown_project', p, 'x', 'hu')).not.toBe('Unknown project: demo')
    expect(uiString('no.such.key', undefined, 'fallback', 'en')).toBe('fallback')
    expect(uiString(undefined, undefined, 'fallback', 'hu')).toBe('fallback')
  })

  it('the agent templates take the owner language from the installer', () => {
    for (const t of ['CLAUDE.md.template', 'SOUL.md.template']) {
      const src = readFileSync(join(ROOT, 'templates', t), 'utf-8')
      expect(src, t).toContain('{{OWNER_LANGUAGE_LINE}}')
      expect(src, t).not.toMatch(/-val magyarul/)
    }
    const lang = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')
    expect(lang).toMatch(/en:owner_language_line\)/)
    expect(lang).toMatch(/hu:owner_language_line\)/)
  })
})
