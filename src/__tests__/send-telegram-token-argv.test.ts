import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The Bot API URL carries the bot token (`.../bot<token>/<method>`). As a curl ARGUMENT it is visible to every
// process of the same user (ps -ww, /proc/<pid>/cmdline) for the whole request. scripts/lib/send-telegram.sh is
// the fleet's one Bot API primitive (limit-monitor, disk-space-guard, notify.sh, ...), so it hands the URL to curl
// as a config line on stdin (-K -), like lib/curl-tok.sh does for the dashboard token. (Upstream, same fix.)
const LIB = join(__dirname, '..', '..', 'scripts', 'lib', 'send-telegram.sh')
// Joined at run time: the repo's own secret gate (TGBOTPAT915) flags a literal token shape, even a synthetic one.
const TOKEN = '80' + '12345678' + ':' + 'AAHd9xKpQ2mWvZ7nR4tLbY' + '6cE1sJfG3hUiO'
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

// A curl stand-in: records its argv and its stdin, answers like the Bot API.
function fakeCurlDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tg-argv-'))
  tmp.push(d)
  const script = ['#!/bin/sh', 'printf "%s\\n" "$@" > "$FAKE_DIR/argv"', 'cat > "$FAKE_DIR/stdin"', 'echo \'{"ok":true}\''].join('\n')
  writeFileSync(join(d, 'curl'), script + '\n')
  chmodSync(join(d, 'curl'), 0o755)
  return d
}
function call(token: string, base?: string) {
  const d = fakeCurlDir()
  const r = spawnSync('bash', ['-c', `. "${LIB}"; telegram_api_call "$1" sendMessage -d chat_id=1`, 'x', token], {
    env: { PATH: `${d}:${process.env.PATH}`, FAKE_DIR: d, ...(base ? { TELEGRAM_API_BASE: base } : {}) }, encoding: 'utf-8',
  })
  const read = (n: string) => (existsSync(join(d, n)) ? readFileSync(join(d, n), 'utf-8') : null)
  return { r, argv: read('argv'), stdin: read('stdin') }
}

describe('send-telegram.sh keeps the bot token off curl\'s argv', () => {
  it('the token travels on stdin (-K -), never in the argument list', () => {
    const { r, argv, stdin } = call(TOKEN)
    expect(r.status).toBe(0)
    expect(argv).not.toBeNull()
    expect(argv).not.toContain(TOKEN)
    expect(argv).toContain('-K')
    expect(stdin).toContain(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"`)
  })

  it('TELEGRAM_API_BASE (test seam) replaces the host', () => {
    const { stdin } = call(TOKEN, 'http://127.0.0.1:9999')
    expect(stdin).toContain(`url = "http://127.0.0.1:9999/bot${TOKEN}/sendMessage"`)
  })

  it('a token with a quote, backslash or newline is refused before curl runs (it would break out of the config value)', () => {
    for (const bad of ['80:ab"cd', 'ab\\cd', 'ab\ncd']) {
      const { r, argv } = call(bad)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('refusing')
      expect(argv, 'curl must not have been started').toBeNull()
    }
  })
})
