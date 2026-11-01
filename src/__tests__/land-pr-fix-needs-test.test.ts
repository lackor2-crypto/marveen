// #823: scripts/land-pr.sh refuses a "fix" commit that touches no test file. The loop that decides it is cut out of the
// script and run against a throwaway git repo, so the test breaks if the gate is removed or stops looking at the files.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = readFileSync(join(__dirname, '..', '..', 'scripts', 'land-pr.sh'), 'utf8')

function gateLoop(): string {
  const a = script.indexOf('NOTEST_FIXES=""')
  const end = script.indexOf('done < <(git log --no-merges', a)
  expect(a).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(a)
  const line = script.indexOf('\n', end)
  return script.slice(a, line) + '\nprintf "%s" "$NOTEST_FIXES"\n'
}

describe('land-pr: a fix commit without a test file is refused', () => {
  it('lists only the fix commit that touches no *.test.* file', () => {
    const d = mkdtempSync(join(tmpdir(), 'landpr-gate-'))
    try {
      const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: d, encoding: 'utf8' })
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'base')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')
      writeFileSync(join(d, 'a.txt'), 'a'); git('add', 'a.txt'); git('commit', '-q', '-m', 'fix(x): no test here')
      writeFileSync(join(d, 'b.test.ts'), 'b'); git('add', 'b.test.ts'); git('commit', '-q', '-m', 'fix(y): has a test')
      writeFileSync(join(d, 'c.txt'), 'c'); git('add', 'c.txt'); git('commit', '-q', '-m', 'feat(z): not a fix')
      const out = execFileSync('bash', ['-c', gateLoop()], { cwd: d, encoding: 'utf8', env: { ...process.env, MAIN_REF: 'refs/remotes/origin/main' } })
      expect(out).toContain('fix(x): no test here')
      expect(out).not.toContain('has a test')
      expect(out).not.toContain('not a fix')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
  it('the refusal is wired in before the push and has the explicit, stated exception', () => {
    expect(script).toContain('die "teszt nelkuli')
    expect(script).toContain('LAND_PR_FIX_WITHOUT_TEST')
    expect(script.indexOf('NOTEST_FIXES=""')).toBeLessThan(script.indexOf('gyors lokalis tipusellenorzes'))
  })
})
