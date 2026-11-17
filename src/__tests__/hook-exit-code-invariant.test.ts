import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #932 (upstream a19ba3ada, widened): exit-code invariant for every hook the settings template wires in, by event class.
//
// Claude Code reads hook exit codes with OPPOSITE failure semantics per event:
//
//   - PreToolUse / Stop gates: exit 2 blocks, exit 0 allows -- and exit 1 is a NON-BLOCKING error: the action proceeds
//     while the gate looks like it ran. A gate that crashes on malformed input therefore fails OPEN silently. Here that
//     was the case for the three live-tree guards (no-live-tree-delete, no-live-tree-commit, no-live-store-delete),
//     the audit log, the file-claim gate, the skill-scope gate, the free-agent read-only gate and the Telegram reply
//     guard: a payload that was valid JSON but no object (or a non-object tool_input) raised AttributeError, exit 1.
//   - UserPromptSubmit / SessionStart / PreCompact / PostCompact / PostToolUse hooks: ANY non-zero blocks the prompt or
//     the event. A hook that crashes on input it cannot understand makes the agent DEAF (the 2026-07 stale-hook-path
//     incident class). Fifteen of them did, for the same reason.
//
// So the invariant is per class: a gate answers 0 or 2 and never 1; every other hook answers 0 on input it cannot
// understand. The hooks are not listed by hand: they are read out of templates/settings.json.template, so a hook added
// there is covered the moment it is wired. Each gets malformed shapes of the payload itself (unparseable, a JSON
// list / null / number / string) and of tool_input (string / number / null / list).

const ROOT = join(__dirname, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'hook-exit-inv-'))
mkdirSync(join(SCRATCH, 'store'), { recursive: true })
symlinkSync(join(ROOT, 'scripts'), join(SCRATCH, 'scripts'))

type Cls = 'gate' | 'prompt'
const GATE_EVENTS = new Set(['PreToolUse', 'Stop'])

// Wired hooks: script -> class. A script wired to a gate event AND another event is a gate.
function wiredHooks(): Map<string, Cls> {
  const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  }
  const out = new Map<string, Cls>()
  for (const [event, groups] of Object.entries(tpl.hooks ?? {})) {
    for (const g of groups) {
      for (const h of g.hooks ?? []) {
        for (const m of (h.command ?? '').matchAll(/scripts\/[\w./-]+\.(?:py|mjs)/g)) {
          const cls: Cls = GATE_EVENTS.has(event) ? 'gate' : 'prompt'
          if (out.get(m[0]) !== 'gate') out.set(m[0], cls)
        }
      }
    }
  }
  // Gates that are wired per agent by the scaffold, not by the template.
  for (const s of ['scripts/hooks/egress-gate.mjs', 'scripts/hooks/telegram-reply-guard.py']) if (!out.has(s)) out.set(s, 'gate')
  return out
}

const BAD_PAYLOADS: Array<{ kind: string; input: string }> = [
  { kind: 'unparseable', input: 'this is not json' },
  { kind: 'empty stdin', input: '' },
  { kind: 'JSON list', input: '[]' },
  { kind: 'JSON null', input: 'null' },
  { kind: 'JSON number', input: '5' },
  { kind: 'JSON string', input: '"x"' },
  ...[['a string', 'x'], ['a number', 5], ['null', null], ['a list', ['not-a-dict']]].map(([what, v]) => ({
    kind: `tool_input is ${what}`,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: v }),
  })),
]

function runHook(script: string, input: string): number {
  try {
    // Hooks run from a tmp install (SCRATCH, scripts/ linked to this repo's): whatever they write goes to its store/,
    // and HOME is the scratch dir too, so nothing lands in the checkout or the real home.
    execFileSync(script.endsWith('.py') ? 'python3' : 'node', [join(SCRATCH, script)], {
      input,
      timeout: 15_000,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, HOME: SCRATCH },
    })
    return 0
  } catch (err) {
    const status = (err as { status?: number }).status
    return typeof status === 'number' ? status : -1
  }
}

const invariantHolds = (cls: Cls, code: number) => (cls === 'gate' ? code === 0 || code === 2 : code === 0)

describe('hook exit-code invariant (fail-open / deaf-agent guard)', () => {
  const hooks = wiredHooks()

  it('finds the wired hooks (the discovery itself is not empty)', () => {
    expect(hooks.size).toBeGreaterThan(25)
  })

  for (const [script, cls] of hooks) {
    it(`${script} [${cls}] keeps its exit code on every malformed payload`, () => {
      const broken = BAD_PAYLOADS.map((p) => ({ kind: p.kind, code: runHook(script, p.input) })).filter((r) => !invariantHolds(cls, r.code))
      expect(
        broken,
        cls === 'gate'
          ? 'a gate must answer 0 or 2: exit 1 is a non-blocking error, the action would proceed UNCHECKED'
          : 'a prompt-path hook must answer 0: any non-zero here blocks the prompt (deaf agent)',
      ).toEqual([])
    }, 60_000)
  }
})
