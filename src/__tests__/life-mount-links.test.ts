// Windows-hivatkozas a git-bekotesekhez (Boss, 2026-10-01): a Windows Intezo is
// lassa a bekotott repot. A valodi hivatkozas-keszites csak WSL + Windows-meghajton
// fut; mashol a modul NEM csinal semmit (es ezt is meg kell mutatni).
import { describe, it, expect } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { toWindowsDrivePath, ensureMountLink, removeMountLink, reconcileMountLinks } = await import('../life-mount-links.js')
const { isWsl } = await import('../web/scheduled-tasks-io.js')

const mk = (rel: string, target: string, kind = 'git') => ({ rel, target, kind, label: 'x', addedAt: '' })

describe('toWindowsDrivePath', () => {
  it('maps a Windows drive path and refuses everything else', () => {
    expect(toWindowsDrivePath('/mnt/f/Marveen/Tőzsde')).toBe('F:\\Marveen\\Tőzsde')
    expect(toWindowsDrivePath('/mnt/c')).toBe('C:\\')
    expect(toWindowsDrivePath('/home/boss/depot')).toBeNull()
    expect(toWindowsDrivePath('/mnt/wsl/x')).toBeNull()
  })
})

describe('mount links', () => {
  it('does nothing when the depot is not on a Windows drive (no side effects)', () => {
    const depot = mkdtempSync(join(tmpdir(), 'marveen-ml-'))
    process.env.MARVEEN_DEPOT = depot
    mkdirSync(join(depot, 'Git', 'r', '.git'), { recursive: true })
    mkdirSync(join(depot, 'P', 'GIT_REPOS'), { recursive: true })
    const m = mk('P/GIT_REPOS/r', 'Git/r')
    expect(ensureMountLink(m, [m]).outcome).toBe('skipped')
    expect(existsSync(join(depot, 'P', 'GIT_REPOS', 'r'))).toBe(false)
    expect(reconcileMountLinks([m])[0].outcome).toBe('skipped')
    expect(removeMountLink(m).outcome).toBe('skipped')
    rmSync(depot, { recursive: true, force: true })
  })

  it('only git mounts get a link', () => {
    expect(ensureMountLink(mk('A/B', 'drive/x', 'drive'), []).reason).toBe('not_git')
  })

  const live = isWsl() && existsSync('/mnt/c/Windows/System32/cmd.exe') && existsSync('/mnt/f')
  it.skipIf(!live)('creates a real junction, is idempotent, never replaces content, and removal keeps the repo', () => {
    const depot = '/mnt/f/zz-marveen-linktest'
    rmSync(depot, { recursive: true, force: true })
    process.env.MARVEEN_DEPOT = depot
    try {
      mkdirSync(join(depot, 'Git', 'acc', 'r1', '.git'), { recursive: true })
      writeFileSync(join(depot, 'Git', 'acc', 'r1', 'f.txt'), 'x')
      mkdirSync(join(depot, 'Proj', 'GIT_REPOS'), { recursive: true })
      mkdirSync(join(depot, 'Full', 'GIT_REPOS', 'keep'), { recursive: true })
      const m = mk('Proj/GIT_REPOS/r1', 'Git/acc/r1')
      expect(ensureMountLink(m, [m]).outcome).toBe('created')
      expect(lstatSync(join(depot, 'Proj', 'GIT_REPOS', 'r1')).isSymbolicLink()).toBe(true)
      expect(readdirSync(join(depot, 'Proj', 'GIT_REPOS', 'r1'))).toContain('f.txt')
      expect(ensureMountLink(m, [m]).outcome).toBe('present')
      // a non-empty folder is never replaced
      const full = mk('Full/GIT_REPOS', 'Git/acc/r1')
      expect(ensureMountLink(full, [full]).reason).toBe('not_empty')
      expect(existsSync(join(depot, 'Full', 'GIT_REPOS', 'keep'))).toBe(true)
      // a mount that nests with another is skipped
      const parent = mk('Proj/GIT_REPOS', 'Git/acc/r1')
      expect(ensureMountLink(parent, [parent, m]).reason).toBe('nested_mount')
      expect(removeMountLink(m).outcome).toBe('removed')
      expect(existsSync(join(depot, 'Git', 'acc', 'r1', 'f.txt'))).toBe(true)
      expect(existsSync(join(depot, 'Proj', 'GIT_REPOS', 'r1'))).toBe(false)
    } finally {
      rmSync(depot, { recursive: true, force: true })
    }
  })
})
