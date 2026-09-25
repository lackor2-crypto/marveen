/**
 * #396 Phase 4 -- compatibility (a newer backup or an unknown format is
 * refused, an older one is allowed with migration) and the path rewrite (slug,
 * known files, the "still points to the old machine" warning).
 */
import { describe, it, expect } from 'vitest'
import { checkCompat, compareVersions } from '../backup/compat.js'
import { planPathRewrites, rewriteSlug, rewriteText, targetFor, isRewritable } from '../backup/path-rewrite.js'

describe('compat', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('1.29.0', '1.29.0')).toBe(0)
    expect(compareVersions('1.30.0', '1.29.9')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
  })
  it('refuses a backup from a newer Marveen', () => {
    expect(checkCompat({ format: 1, appVersion: '1.30.0' }, '1.29.0', null)).toMatchObject({ ok: false, reason: 'backup_newer' })
  })
  it('refuses an unknown format', () => {
    expect(checkCompat({ format: 2, appVersion: '1.0.0' }, '1.29.0', null)).toMatchObject({ ok: false, reason: 'format_unknown' })
    expect(checkCompat({ appVersion: '1.0.0' } as any, '1.29.0', null).ok).toBe(false)
  })
  it('allows an older one, with migration', () => {
    expect(checkCompat({ format: 1, appVersion: '1.20.0', db: { schemaFingerprint: 'a' } }, '1.29.0', 'b')).toEqual({ ok: true, needsMigration: true })
    expect(checkCompat({ format: 1, appVersion: '1.29.0', db: { schemaFingerprint: 'a' } }, '1.29.0', 'a')).toEqual({ ok: true, needsMigration: false })
  })
})

describe('path rewrite', () => {
  const hints = { PROJECT_ROOT: '/home/old/marveen', HOME: '/home/old', STORE_DIR: '/home/old/marveen/store', projectSlug: '-home-old-marveen' }
  const cur = { projectRoot: '/Users/new.person/mv', storeDir: '/Users/new.person/mv/store', home: '/Users/new.person' }
  const manifest: any = {
    pathHints: hints,
    roots: {
      'config/main': { kind: 'main', base: 'home', rel: '.claude-marvin' },
      'config/acc': { kind: 'account', base: 'project', rel: 'store/accounts/acc' },
      'config/abs': { kind: 'agent', base: 'abs', rel: '/home/old/elsewhere/cfg' },
    },
  }

  it('plans project root, home and slug moves; nothing when paths match', () => {
    expect(planPathRewrites(hints, cur).map((r) => r.what)).toEqual(['project_root', 'home', 'slug'])
    expect(planPathRewrites(hints, { projectRoot: hints.PROJECT_ROOT, storeDir: hints.STORE_DIR, home: hints.HOME })).toEqual([])
  })

  it('the slug uses Claude Code\'s encoding (dots too) and follows sub-dirs', () => {
    const newSlug = '-Users-new-person-mv'
    expect(rewriteSlug('-home-old-marveen', hints.projectSlug, newSlug)).toBe(newSlug)
    expect(rewriteSlug('-home-old-marveen-agents-alpha', hints.projectSlug, newSlug)).toBe(newSlug + '-agents-alpha')
    expect(rewriteSlug('-home-old-other', hints.projectSlug, newSlug)).toBe('-home-old-other')
  })

  it('maps every logical root', () => {
    expect(targetFor('project/store/vault.json', manifest, cur)).toBe('/Users/new.person/mv/store/vault.json')
    expect(targetFor('project/agents/a/CLAUDE.md', manifest, cur)).toBe('/Users/new.person/mv/agents/a/CLAUDE.md')
    expect(targetFor('home/.claude/skills/x', manifest, cur)).toBe('/Users/new.person/.claude/skills/x')
    expect(targetFor('config/main/projects/-home-old-marveen/memory/m.md', manifest, cur))
      .toBe('/Users/new.person/.claude-marvin/projects/-Users-new-person-mv/memory/m.md')
    expect(targetFor('config/acc/projects/-home-old-marveen/memory/m.md', manifest, cur))
      .toBe('/Users/new.person/mv/store/accounts/acc/projects/-Users-new-person-mv/memory/m.md')
    expect(targetFor('config/abs/skills/s', manifest, cur)).toBe('/Users/new.person/elsewhere/cfg/skills/s')
    expect(targetFor('config/unknown/x', manifest, cur)).toBeNull()
  })

  it('rewrites the project root before home, and only known files', () => {
    const rw = planPathRewrites(hints, cur)
    expect(rewriteText('{"a":"/home/old/marveen/store/x","b":"/home/old/Documents"}', rw))
      .toBe('{"a":"/Users/new.person/mv/store/x","b":"/Users/new.person/Documents"}')
    expect(isRewritable('project/agents/x/agent-config.json')).toBe(true)
    expect(isRewritable('project/store/life-mounts.json')).toBe(true)
    expect(isRewritable('project/store/knowledge/notes.md')).toBe(false)
  })
})
