import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'subagent-retry.sh'), 'utf8')

describe('#958 sub-agent retry watcher: exhausted budget stays off Telegram', () => {
  it('does not notify when the hourly retry budget is used up', () => {
    expect(sh).not.toMatch(/notify_once\s+"budget-/)
  })
  it('still logs it and keeps the persistent-config (model) notification', () => {
    expect(sh).toContain('elfogyott az ora-keret')
    expect(sh).toMatch(/notify_once\s+"model-\$a"/)
  })
})

// Behavioural proof (not just a text grep): run the real script against a fake
// tmux whose pane shows a provider error, with the hourly budget already used.
// Nothing may reach the (fake) notify.sh; the log line must still be written.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

describe('#958 behavioural: exhausted budget -> no notify.sh call', () => {
  it('runs the script with the budget used up and sends nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'retry958-'))
    try {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
      mkdirSync(join(root, 'store', '.subagent-retry'), { recursive: true })
      mkdirSync(join(root, 'bin'))
      const src = join(__dirname, '..', '..', 'scripts')
      copyFileSync(join(src, 'subagent-retry.sh'), join(root, 'scripts', 'subagent-retry.sh'))
      copyFileSync(join(src, 'lib', 'owner-lang.sh'), join(root, 'scripts', 'lib', 'owner-lang.sh'))
      writeFileSync(join(root, 'store', 'agents-desired.json'), '["zed"]')
      // budget window started now, count already at the maximum (2)
      writeFileSync(join(root, 'store', '.subagent-retry', 'zed'), `${Math.floor(Date.now() / 1000)}:2`)
      const marker = join(root, 'notify-called')
      writeFileSync(join(root, 'scripts', 'notify.sh'), `#!/bin/bash\ntouch "${marker}"\n`)
      chmodSync(join(root, 'scripts', 'notify.sh'), 0o755)
      writeFileSync(join(root, 'bin', 'tmux'),
        '#!/bin/bash\ncase "$1" in has-session) exit 0;; capture-pane) echo "API Error: 429 Request rejected (429)"; exit 0;; *) exit 0;; esac\n')
      chmodSync(join(root, 'bin', 'tmux'), 0o755)

      execFileSync('bash', [join(root, 'scripts', 'subagent-retry.sh')], {
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MARVEEN_LANG: 'hu' },
        timeout: 20000,
      })

      expect(existsSync(marker)).toBe(false)
      const log = execFileSync('cat', [join(root, 'store', 'subagent-retry.log')], { encoding: 'utf8' })
      expect(log).toContain('elfogyott az ora-keret')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
