// #968 (Boss TG 7361): a sub-agent whose model/provider is unavailable is an EXTERNAL provider problem -- the owner
// hears about it at most once a month, not every 6 hours. Real script, fake tmux + fake notify.sh.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function run(lastNoticeDaysAgo: number | null): boolean {
  const root = mkdtempSync(join(tmpdir(), 'retry968-'))
  try {
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'store', '.subagent-retry'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    const src = join(__dirname, '..', '..', 'scripts')
    copyFileSync(join(src, 'subagent-retry.sh'), join(root, 'scripts', 'subagent-retry.sh'))
    copyFileSync(join(src, 'lib', 'owner-lang.sh'), join(root, 'scripts', 'lib', 'owner-lang.sh'))
    writeFileSync(join(root, 'store', 'agents-desired.json'), '["zed"]')
    if (lastNoticeDaysAgo !== null) {
      writeFileSync(join(root, 'store', '.subagent-retry', '.notified-model-zed'), String(Math.floor(Date.now() / 1000) - lastNoticeDaysAgo * 86400))
    }
    const marker = join(root, 'notify-called')
    writeFileSync(join(root, 'scripts', 'notify.sh'), `#!/bin/bash\ntouch "${marker}"\n`)
    chmodSync(join(root, 'scripts', 'notify.sh'), 0o755)
    writeFileSync(join(root, 'bin', 'tmux'),
      '#!/bin/bash\ncase "$1" in has-session) exit 0;; capture-pane) echo "There is an issue with the selected model. Pick a different model"; exit 0;; *) exit 0;; esac\n')
    chmodSync(join(root, 'bin', 'tmux'), 0o755)
    execFileSync('bash', [join(root, 'scripts', 'subagent-retry.sh')], {
      env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MARVEEN_LANG: 'hu' },
      timeout: 20000,
    })
    return existsSync(marker)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('#968 sub-agent model/provider notice is monthly', () => {
  it('the first time it still tells the owner', () => { expect(run(null)).toBe(true) })
  it('10 days after the last notice it stays silent', () => { expect(run(10)).toBe(false) })
  it('31 days after the last notice it tells the owner again', () => { expect(run(31)).toBe(true) })
})
