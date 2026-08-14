import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { exactTmuxTarget, normalizeTmuxTargetArgs } from '../web/tmux-target.js'
import { buildTmuxInvocation } from '../web/ssh-tmux.js'

// tmux resolves `-t <name>` loosely: exact, then fnmatch, then an unambiguous
// PREFIX. Measured on tmux 3.4 with only a session `probe9` alive, `send-keys
// -t probe` succeeds and the keys land in probe9. The fleet really does own
// such a pair (`nemotronnano` / `nemotronnano9`), so an Escape, a /clear, a
// capture or a kill-session aimed at the stopped one would have hit the running
// one. Every tmux target must therefore be the exact form `=name:`.

describe('exactTmuxTarget', () => {
  it('turns a bare session name into the universally accepted exact form', () => {
    // `=name` alone is rejected by the PANE commands ("can't find pane: =name"),
    // `=name:` is accepted by session, window and pane commands alike.
    expect(exactTmuxTarget('agent-nemotronnano')).toBe('=agent-nemotronnano:')
    expect(exactTmuxTarget('lackor2-bot-worker-fast')).toBe('=lackor2-bot-worker-fast:')
  })

  it('is idempotent, so double-wrapping a target is harmless', () => {
    expect(exactTmuxTarget(exactTmuxTarget('agent-x'))).toBe('=agent-x:')
  })

  it('keeps an explicit window/pane suffix and only anchors the session half', () => {
    expect(exactTmuxTarget('agent-x:0')).toBe('=agent-x:0')
    expect(exactTmuxTarget('agent-x:0.1')).toBe('=agent-x:0.1')
  })

  it('leaves id-style targets alone (tmux resolves those exactly already)', () => {
    expect(exactTmuxTarget('%12')).toBe('%12')
    expect(exactTmuxTarget('$3')).toBe('$3')
  })

  it('leaves anything that is not a plain session name untouched', () => {
    // Never invent a target out of something we do not understand: pass it
    // through and let tmux reject it, rather than silently retargeting.
    expect(exactTmuxTarget('')).toBe('')
    expect(exactTmuxTarget('agent x')).toBe('agent x')
    expect(exactTmuxTarget('-weird')).toBe('-weird')
  })
})

describe('normalizeTmuxTargetArgs', () => {
  it('rewrites the target of a pane command', () => {
    expect(normalizeTmuxTargetArgs(['send-keys', '-t', 'agent-x', 'Enter']))
      .toEqual(['send-keys', '-t', '=agent-x:', 'Enter'])
  })

  it('rewrites every target when there is more than one', () => {
    expect(normalizeTmuxTargetArgs(['x', '-t', 'a', '-t', 'b']))
      .toEqual(['x', '-t', '=a:', '-t', '=b:'])
  })

  it('stops at `--`, where tmux stops reading flags', () => {
    // `send-keys -l -- -t` sends the literal two-character text `-t`; treating
    // it as a target flag would corrupt the message the user typed.
    expect(normalizeTmuxTargetArgs(['send-keys', '-t', 'agent-x', '-l', '--', '-t', 'agent-y']))
      .toEqual(['send-keys', '-t', '=agent-x:', '-l', '--', '-t', 'agent-y'])
  })

  it('does not touch a trailing bare -t with no value', () => {
    expect(normalizeTmuxTargetArgs(['kill-session', '-t'])).toEqual(['kill-session', '-t'])
  })

  it('does not mutate the caller\'s array', () => {
    const args = ['send-keys', '-t', 'agent-x', 'Enter']
    normalizeTmuxTargetArgs(args)
    expect(args[2]).toBe('agent-x')
  })
})

describe('buildTmuxInvocation normalises targets', () => {
  it('locally', () => {
    expect(buildTmuxInvocation(null, '/usr/bin/tmux', ['kill-session', '-t', 'agent-x']).args)
      .toEqual(['kill-session', '-t', '=agent-x:'])
  })

  it('and remotely, still shell-quoted', () => {
    const inv = buildTmuxInvocation('laptop', '/usr/bin/tmux', ['send-keys', '-t', 'agent-x', 'Enter'])
    expect(inv.file).toBe('ssh')
    expect(inv.args[inv.args.length - 1]).toBe("tmux 'send-keys' '-t' '=agent-x:' 'Enter'")
  })
})

// ---------------------------------------------------------------------------
// Static gate. Modules that call the tmux binary DIRECTLY bypass
// buildTmuxInvocation, so nothing normalises their targets for them. New code
// like that is exactly how this bug came back into the tree, so scan for it.

const SRC = join(__dirname, '..')

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') tsFiles(full, out)
    } else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

// execFile/execFileSync whose binary is tmux, up to the end of the argv array.
const DIRECT_TMUX_CALL = /execFile(?:Sync)?\(\s*(?:TMUX|tmuxBin\(\)|['"][^'"]*\/tmux['"])\s*,\s*\[([\s\S]*?)\]/g
// A tmux argv RETURNED by a pure builder (tmux-keys.ts): nothing normalises it
// on the way out either. Argv literals passed inline to runTmux/captureTmux are
// deliberately not scanned -- those go through buildTmuxInvocation.
const TMUX_ARGV_BUILDER = /return\s*\[\s*'(?:send-keys|capture-pane|has-session|kill-session|list-panes|display-message|respawn-pane|rename-session)'[\s\S]*?\]/g
const TARGET_ARG = /'-t',\s*([^\s,\]]+)/g

function badTargets(body: string): string[] {
  const bad: string[] = []
  let m: RegExpExecArray | null
  TARGET_ARG.lastIndex = 0
  while ((m = TARGET_ARG.exec(body))) {
    const value = m[1]
    if (value.startsWith('exactTmuxTarget(')) continue
    if (value.startsWith("'=") || value.startsWith('`=')) continue
    bad.push(value)
  }
  return bad
}

describe('every direct tmux call targets an exact session', () => {
  it('has no unanchored -t argument anywhere in src/', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, 'utf-8')
      for (const re of [DIRECT_TMUX_CALL, TMUX_ARGV_BUILDER]) {
        re.lastIndex = 0
        let call: RegExpExecArray | null
        while ((call = re.exec(src))) {
          for (const value of badTargets(call[0])) {
            offenders.push(`${file.slice(SRC.length + 1)}: -t ${value}`)
          }
        }
      }
    }
    // Wrap it: exactTmuxTarget(session). Anything reached through runTmux /
    // captureTmux / buildTmuxInvocation is already normalised centrally.
    expect(offenders).toEqual([])
  })
})
