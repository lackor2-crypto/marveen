import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  SYSTEM_DEPS, installCommand, measureSystemDeps, detectPkgManager,
  _setSystemDepsSnapshot, type DepResult, type DepsSnapshot, type SystemDep,
} from '../system-deps.js'
import { systemDepRows, SYSTEM_DEPS_GRACE_MS } from '../web/system-health.js'
import { systemProgramsComplete } from '../web/routes/setup-wizard.js'
import { SETUP_ITEMS } from '../web/setup-wizard-registry.js'
import { ttsBodyCommand } from '../web/voice-directive.js'

// Kanban d7acdd75. Boss (uzenet 1217): "ossze kellene szedni az osszes ilyen
// programot ... a varazsloba ezt betenni ... az onellenorzes is erzekelje ...
// uj telepitesnel is". Ezek a tesztek azt tartjak egyben, hogy a LISTA, a
// TELEPITO es a FELULET ugyanarrol beszeljen.

const ROOT = join(__dirname, '..', '..')
const installer = readFileSync(join(ROOT, 'install-linux.sh'), 'utf8')

function item(over: Partial<DepResult>): DepResult {
  return {
    id: 'x', name: 'X', tier: 'recommended', state: 'ok', version: null, path: null, detail: null,
    what_for: { hu: '', en: '' }, affects: { hu: '', en: '' }, packages: ['x'], manual: null, url: 'https://example.org', self_install: null,
    ...over,
  }
}
function snap(items: DepResult[]): DepsSnapshot {
  return { measured_at: 1, pkg_manager: 'apt', items }
}

afterEach(() => _setSystemDepsSnapshot(null, null))

describe('a lista es a friss telepito egyutt jar', () => {
  it('minden alap/ajanlott apt- es dnf-csomag benne van az install-linux.sh-ban', () => {
    for (const d of SYSTEM_DEPS.filter(d => d.tier !== 'extra')) {
      for (const p of [...d.apt, ...d.dnf]) {
        expect(installer, `${d.id}: a(z) "${p}" csomagot a friss telepites nem kapja meg`).toMatch(new RegExp(`\\b${p.replace(/[.+]/g, '\\$&')}\\b`))
      }
    }
  })

  it('a csomagkezelovel nem telepitheto ajanlott programok (himalaya, bun) kezi letoltessel jonnek', () => {
    const noPkg = SYSTEM_DEPS.filter(d => d.tier !== 'extra' && d.apt.length === 0)
    expect(noPkg.map(d => d.id)).toEqual(['himalaya', 'bun'])
    expect(installer).toMatch(/install_himalaya/)
    expect(installer).toMatch(/sha256sum -c/)
    // A Telegram-csatorna bun-nal fut (agent-process.ts ~/.bun/bin/bun).
    expect(installer).toMatch(/bun\.sh\/install/)
    const bun = SYSTEM_DEPS.find(d => d.id === 'bun')
    expect(bun?.commands[0]).toMatch(/\.bun\/bin\/bun$/)
    expect(bun?.manual?.hu && bun?.manual?.en).toBeTruthy()
  })

  it('minden bejegyzes kitoltott: nev, link, parancs, ketnyelvu leiras', () => {
    const ids = SYSTEM_DEPS.map(d => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const d of SYSTEM_DEPS) {
      expect(d.url, d.id).toMatch(/^https:\/\//)
      // A self-installed entry (face recognizer) has a button instead of a
      // command line; everything else must give the user a line to paste.
      if (d.selfInstall) expect(d.commands.length, d.id).toBe(0)
      else expect(d.commands.length, d.id).toBeGreaterThan(0)
      expect(d.affects.hu && d.affects.en, d.id).toBeTruthy()
      expect(d.what_for.hu && d.what_for.en, d.id).toBeTruthy()
    }
    expect(ids).toContain('libreoffice')
  })

  it('a varazsloban van rendszer-programok lepes, es nem kotelezo', () => {
    const it2 = SETUP_ITEMS.find(i => i.id === 'system-programs')
    expect(it2?.kind).toBe('external')
    expect(it2?.flowId).toBe('system-deps')
    expect(it2?.required).toBe(false)
  })
})

describe('installCommand', () => {
  it('csak a hianyzo alap/ajanlott csomagokat teszi bele, extrat soha', () => {
    const cmd = installCommand([
      item({ id: 'a', packages: ['jq'], state: 'not_installed' }),
      item({ id: 'b', packages: ['sqlite3'], state: 'ok' }),
      item({ id: 'c', packages: ['gh'], state: 'not_installed', tier: 'extra' }),
      item({ id: 'd', packages: ['poppler-utils'], state: 'check_failed' }),
    ], 'apt')
    expect(cmd).toBe('sudo apt-get install -y --no-install-recommends jq poppler-utils')
  })
  it('nincs mit telepiteni vagy ismeretlen csomagkezelo -> null', () => {
    expect(installCommand([item({ state: 'ok' })], 'apt')).toBeNull()
    expect(installCommand([item({ state: 'not_installed' })], null)).toBeNull()
  })
  it('brew: a cask kulon parancsba megy', () => {
    const cmd = installCommand([
      item({ packages: ['poppler'], state: 'not_installed' }),
      item({ id: 'lo', packages: ['--cask libreoffice'], state: 'not_installed' }),
    ], 'brew')
    expect(cmd).toBe('brew install poppler && brew install --cask libreoffice')
  })
  it('dnf', () => {
    expect(installCommand([item({ packages: ['sqlite'], state: 'not_installed' })], 'dnf')).toBe('sudo dnf install -y sqlite')
  })
  it('detectPkgManager a letezo binarisbol dont', () => {
    expect(detectPkgManager(p => p === '/usr/bin/apt-get')).toBe('apt')
    expect(detectPkgManager(p => p === '/usr/bin/dnf')).toBe('dnf')
    expect(detectPkgManager(p => p === '/opt/homebrew/bin/brew')).toBe('brew')
    expect(detectPkgManager(() => false)).toBeNull()
  })
})

describe('systemDepRows: a nulla ket dolgot jelenthet', () => {
  it('meg nincs meres, de a meres epp fut -> csend', () => {
    expect(systemDepRows(null, 1000, 1000 + SYSTEM_DEPS_GRACE_MS - 1)).toEqual([])
  })
  it('a turelmi ido utan sincs meres -> kimondjuk (nem "rendben")', () => {
    expect(systemDepRows(null, 1000, 1000 + SYSTEM_DEPS_GRACE_MS + 1)[0]).toMatchObject({ id: 'system_deps_unmeasured', status: 'warn' })
    expect(systemDepRows(null, null, 5)[0]?.id).toBe('system_deps_unmeasured')
  })
  it('hianyzo alapprogram -> piros; hianyzo ajanlott -> sarga; nem sikerult megnezni -> kulon sor', () => {
    const rows = systemDepRows(snap([
      item({ name: 'git', tier: 'core', state: 'not_installed' }),
      item({ name: 'LibreOffice', state: 'not_installed' }),
      item({ name: 'jq', state: 'check_failed' }),
    ]), null, 0)
    expect(rows).toEqual([
      { id: 'system_deps_core_missing', status: 'bad', params: { n: 1, names: 'git' } },
      { id: 'system_deps_missing', status: 'warn', params: { n: 1, names: 'LibreOffice' } },
      { id: 'system_deps_check_failed', status: 'warn', params: { n: 1, names: 'jq' } },
    ])
  })
  it('hianyzo EXTRA soha nem sarga', () => {
    const rows = systemDepRows(snap([
      item({ name: 'git', tier: 'core' }),
      item({ name: 'gh', tier: 'extra', state: 'not_installed' }),
      item({ name: 'ollama', tier: 'extra', state: 'check_failed' }),
    ]), null, 0)
    expect(rows).toEqual([{ id: 'system_deps_ok', status: 'ok', params: { n: 1 } }])
  })
  it('a varazslo lepese kesz, ha csak extra hianyzik; meres nelkul nem kesz', () => {
    expect(systemProgramsComplete(null)).toBe(false)
    expect(systemProgramsComplete(snap([item({}), item({ tier: 'extra', state: 'not_installed' })]))).toBe(true)
    expect(systemProgramsComplete(snap([item({ state: 'check_failed' })]))).toBe(false)
  })
})

describe('measureSystemDeps a valodi meressel', () => {
  it('egy nem letezo parancs not_installed, egy letezo ok', async () => {
    const fake: SystemDep[] = [
      { id: 'nincs', name: 'Nincs', tier: 'recommended', what_for: { hu: 'a', en: 'a' }, affects: { hu: 'a', en: 'a' },
        apt: ['nincs'], dnf: ['nincs'], brew: ['nincs'], url: 'https://example.org',
        commands: ['marveen-surely-not-installed-xyz'], versionArgs: ['--version'] },
      { id: 'node', name: 'node', tier: 'core', what_for: { hu: 'a', en: 'a' }, affects: { hu: 'a', en: 'a' },
        apt: [], dnf: [], brew: [], url: 'https://example.org',
        commands: [process.execPath], versionArgs: ['--version'] },
    ]
    const s = await measureSystemDeps(true, fake)
    expect(s.items.find(i => i.id === 'nincs')?.state).toBe('not_installed')
    const n = s.items.find(i => i.id === 'node')
    expect(n?.state).toBe('ok')
    expect(n?.version).toContain(process.versions.node)
  })
})

describe('ttsBodyCommand: a hangvalasz jq nelkul is mukodik', () => {
  it('a kimenet ervenyes JSON, idezojellel a szovegben es az utban is', () => {
    const cmd = ttsBodyCommand('123', "/tmp/it's here", 'hu-model')
    const out = execFileSync('bash', ['-c', `${cmd} "$1"`, 'x', 'Szia "Jani", it\'s $HOME ok'], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({
      text: 'Szia "Jani", it\'s $HOME ok', chat_id: '123', state_dir: "/tmp/it's here", voice_model: 'hu-model',
    })
    expect(cmd).not.toMatch(/\bjq\b/)
  })
})

describe('verzio a hibakimenetrol is (lsof -v, pdftotext -v)', () => {
  it('ha a program a verziot stderr-re irja, azt olvassuk ki', async () => {
    const fake: SystemDep[] = [{
      id: 'stderr-ver', name: 'x', tier: 'recommended', what_for: { hu: 'a', en: 'a' }, affects: { hu: 'a', en: 'a' },
      apt: [], dnf: [], brew: [], url: 'https://example.org',
      commands: [process.execPath],
      versionArgs: ['-e', 'process.stderr.write("tool version information:\\n    revision: 4.95.0\\n")'],
    }]
    const s = await measureSystemDeps(true, fake)
    expect(s.items[0]).toMatchObject({ state: 'ok', version: 'revision: 4.95.0' })
  })
})
