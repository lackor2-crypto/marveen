// #932 (upstream f62a8faf7 round 3, extended to the rest of our scripts): the dashboard token must never sit on curl's
// argv, because ps and /proc/<pid>/cmdline show it to every process of the same user. Fourteen call sites in ten
// fleet scripts still did `-H "Authorization: Bearer <token>"`. They now hand curl the header from a process
// substitution (-H @<(printf ...)): printf is a builtin, so no child's argv carries the token, and nothing goes to disk.
//
// Two checks. (1) A scan over every scripts/*.sh: no curl call may put the dashboard token on its command line, so a
// new script (or a backfill) that brings the pattern back turns this red. (2) One real run of scripts/agent-msg.sh
// (the script every agent uses to talk to another) with a curl stub first on PATH that records the argv, the
// environment and the header source it was started with: the server side still gets the header, the argv does not.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOKEN = 'fleetargv-test-token-0123456789abcdef'

// Not the dashboard token on a curl argv: supabase-q.sh passes its header through a curl config on stdin, the Slack
// smoke test sends a Slack bot token to Slack's own API, and fix-agent-auth-headers.sh WRITES curl examples into
// agent CLAUDE.md files (text for an agent, not a call made here).
const NOT_THE_DASHBOARD_TOKEN = new Set(['supabase-q.sh', 'smoke-test-slack-channel.sh', 'fix-agent-auth-headers.sh'])

describe('no fleet script puts the dashboard token on curl\'s argv', () => {
  const dir = join(REPO, 'scripts')
  const scripts = readdirSync(dir).filter((f) => f.endsWith('.sh') && !NOT_THE_DASHBOARD_TOKEN.has(f))

  it('scans a real set of scripts (the scan itself is not empty)', () => {
    expect(scripts.length).toBeGreaterThan(20)
  })

  it('no non-comment line carries -H "Authorization: Bearer $..." (the header goes in through a process substitution)', () => {
    const offenders: string[] = []
    for (const f of scripts) {
      readFileSync(join(dir, f), 'utf-8').split('\n').forEach((line, i) => {
        if (/^\s*#/.test(line)) return
        if (/-H\s+"Authorization:\s*Bearer\s+\$/.test(line)) offenders.push(`scripts/${f}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('scripts/agent-msg.sh sends the header without the token on curl\'s argv', () => {
  it('the server side gets the header; argv and environment do not carry the token', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'token-argv-fleet-')))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'store'))
    mkdirSync(join(root, 'bin'))
    copyFileSync(join(REPO, 'scripts', 'agent-msg.sh'), join(root, 'scripts', 'agent-msg.sh'))
    writeFileSync(join(root, 'store', '.dashboard-token'), TOKEN + '\n')
    const argvLog = join(root, 'argv.log')
    const hdrLog = join(root, 'hdr.log')
    const envLog = join(root, 'env.log')
    // The stub records what ps / a child's environment would show and what header the real server would have got.
    writeFileSync(join(root, 'bin', 'curl'), [
      '#!/bin/bash',
      `printf '%s\\n' "$@" >> "${argvLog}"`,
      `env >> "${envLog}"`,
      'for a in "$@"; do',
      '  case "$a" in',
      `    @*) cat "\${a#@}" >> "${hdrLog}" ;;`,
      '  esac',
      'done',
      `printf '{"id":7}\\n200'`,
    ].join('\n') + '\n')
    chmodSync(join(root, 'bin', 'curl'), 0o755)

    const res = spawnSync('bash', [join(root, 'scripts', 'agent-msg.sh'), 'a-bot', 'b-bot', 'hello'], {
      encoding: 'utf-8',
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, HOME: root },
    })
    expect(res.stdout + res.stderr).toContain('OK id=7')
    expect(readFileSync(hdrLog, 'utf-8')).toContain(`Authorization: Bearer ${TOKEN}`)
    expect(readFileSync(argvLog, 'utf-8')).not.toContain(TOKEN)
    expect(readFileSync(envLog, 'utf-8')).not.toContain(TOKEN)
    // The rest of the call is intact.
    expect(readFileSync(argvLog, 'utf-8')).toContain('http://localhost:3420/api/messages')
  })
})
