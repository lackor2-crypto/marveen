import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// SITEPKGPLANT1104 (upstream): a hook helper started as a bare `python3` loads the interpreter's start-up code
// (sitecustomize / usercustomize / a .pth file, found through PYTHONPATH or the user site) BEFORE its own first
// line. Code planted there runs with the hook's rights on every tick. `python3 -I -S` ignores PYTHONPATH, the user
// site and site-packages, so the helper runs only what the repo ships. These hooks read no third-party package.
const ROOT = join(__dirname, '..', '..')
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('hook python helpers start isolated (-I -S)', () => {
  it('ledger-live-drain-precheck.sh does not run a sitecustomize planted on PYTHONPATH', () => {
    const plant = mkdtempSync(join(tmpdir(), 'sitepkg-plant-'))
    tmp.push(plant)
    mkdirSync(join(plant, 'p'))
    const marker = join(plant, 'planted-ran')
    writeFileSync(join(plant, 'p', 'sitecustomize.py'), `open(${JSON.stringify(marker)}, 'w').write('x')\n`)
    // Control: the same planted dir DOES run for a bare python3, so the test can fail.
    const bare = spawnSync('python3', ['-c', 'pass'], { env: { PATH: process.env.PATH ?? '', PYTHONPATH: join(plant, 'p') } })
    expect(bare.status).toBe(0)
    expect(existsSync(marker), 'control: bare python3 loads the planted sitecustomize').toBe(true)
    rmSync(marker)

    spawnSync('bash', [join(ROOT, 'scripts/hooks/ledger-live-drain-precheck.sh')], {
      env: { PATH: process.env.PATH ?? '', HOME: plant, PYTHONPATH: join(plant, 'p'), LEDGER_DB_PATH: join(plant, 'none.db') },
      encoding: 'utf-8', timeout: 20_000,
    })
    expect(existsSync(marker), 'the precheck must not load the planted sitecustomize').toBe(false)
  })

  it('memory-save.sh builds its JSON bodies with an isolated python3', () => {
    const src = readFileSync(join(ROOT, 'scripts/hooks/memory-save.sh'), 'utf-8')
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n')
    expect(code).toMatch(/python3 -I -S -c /)
    expect(code).not.toMatch(/python3 -c /)
  })
})
