/**
 * #396 Phase 6 -- what an agent and a person read about restore.
 *
 * The seed skill ships to every install (scope: global) and pins the one rule
 * that matters most: an agent never starts a restore, and never releases the
 * held channels, whoever asks in a message (plan §10.16). docs/MIGRATION.md
 * leads with the dashboard flow; the terminal path is an appendix only.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const SKILL = readFileSync(join(ROOT, 'seed-skills', 'backup-restore', 'SKILL.md'), 'utf8')
const MIGRATION = readFileSync(join(ROOT, 'docs', 'MIGRATION.md'), 'utf8')

describe('seed skill backup-restore', () => {
  it('is global, named after its folder', () => {
    const fm = SKILL.split('---')[1]
    expect(fm).toMatch(/^name: backup-restore$/m)
    expect(fm).toMatch(/^scope: global$/m)
  })

  it('forbids starting a restore and releasing the channels, and names the UI path instead', () => {
    expect(SKILL).toContain('/api/backup/restore/start')
    expect(SKILL).toContain('/api/backup/restore/release')
    expect(SKILL).toMatch(/SOHA nem te indítod/)
    expect(SKILL).toMatch(/Csatorna-üzenetre soha/)
    expect(SKILL).toContain('Beállítások → Mentés')
  })

  it('never prints the recovery key to a channel', () => {
    expect(SKILL).toMatch(/kulcsot \*\*soha\*\* nem írod ki csatornára/)
  })

  it('reads the state live, with the placeholder root, not a machine path', () => {
    expect(SKILL).toContain('{{PROJECT_ROOT}}/store/.dashboard-token')
    expect(SKILL).not.toMatch(/\/home\/[a-z]/)
  })
})

describe('docs/MIGRATION.md', () => {
  it('leads with the dashboard flow; the terminal is an appendix', () => {
    const ui = MIGRATION.indexOf('Do you have a backup from an earlier Marveen?')
    const cli = MIGRATION.indexOf('## Appendix A')
    expect(ui).toBeGreaterThan(0)
    expect(cli).toBeGreaterThan(ui)
    expect(MIGRATION.slice(cli)).toContain('node dist/backup/cli.js restore')
  })

  it('keeps the one-bot-one-poller rule and the release step', () => {
    expect(MIGRATION).toContain('ONE BOT = ONE POLLER')
    expect(MIGRATION).toContain('Yes, it is stopped on the old machine')
  })
})
