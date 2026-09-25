// #393 -- a seeded task-config.json must not keep a template placeholder.
//
// ledger-live-drain shipped `"preCheck": "{{PROJECT_ROOT}}/scripts/hooks/..."`;
// the seeder only rewrote the `agent` field of task-config.json, so the
// placeholder reached the scheduler verbatim, was taken as a relative path,
// never ran, and every 2-minute tick woke the model.
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync as rf } from 'node:fs'

const { healTaskConfigPlaceholders } = await import('../web/agent-scaffold.js')
const { PROJECT_ROOT } = await import('../config.js')

const tmp = mkdtempSync(join(tmpdir(), 'task-cfg-ph-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('task-config.json placeholders (#393)', () => {
  it('an already-seeded config with {{PROJECT_ROOT}} is healed, other fields untouched', () => {
    const p = join(tmp, 'a.json')
    writeFileSync(p, JSON.stringify({ schedule: '*/2 * * * *', agent: 'x', preCheck: '{{PROJECT_ROOT}}/scripts/hooks/p.sh', note: 'kept' }, null, 2))
    expect(healTaskConfigPlaceholders(p)).toBe(true)
    const cfg = JSON.parse(readFileSync(p, 'utf-8'))
    expect(cfg.preCheck).toBe(PROJECT_ROOT + '/scripts/hooks/p.sh')
    expect(cfg.note).toBe('kept')
    expect(cfg.agent).toBe('x')
  })

  it('is idempotent and leaves a clean config alone', () => {
    const p = join(tmp, 'b.json')
    const body = JSON.stringify({ schedule: '0 9 * * *', agent: 'x' })
    writeFileSync(p, body)
    expect(healTaskConfigPlaceholders(p)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe(body)
  })

  it('the first-seed path resolves placeholders in task-config.json too', () => {
    const src = rf('src/web/agent-scaffold.ts', 'utf8')
    const fn = src.slice(src.indexOf('function copyTaskConfigWithAgentRewrite('), src.indexOf('export function healTaskConfigPlaceholders('))
    expect(fn).toContain("resolveTemplatePlaceholders(readFileSync(srcPath, 'utf-8'))")
    expect(src).toMatch(/if \(existsSync\(dest\)\) \{ healTaskConfigPlaceholders\(join\(dest, 'task-config\.json'\)\); continue \}/)
  })

  it('the shell seeders substitute {{PROJECT_ROOT}} wherever they substitute {{INSTALL_DIR}}', () => {
    for (const f of ['update.sh', 'install-linux.sh', 'install-macos.sh']) {
      const t = rf(f, 'utf8')
      const inst = (t.match(/-e "s\|\{\{INSTALL_DIR\}\}\|\$INSTALL_DIR\|g" \\/g) || []).length
      const proj = (t.match(/-e "s\|\{\{PROJECT_ROOT\}\}\|\$INSTALL_DIR\|g" \\/g) || []).length
      expect(proj, f).toBeGreaterThanOrEqual(inst)
    }
  })
})
