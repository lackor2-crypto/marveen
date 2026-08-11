import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTemplatePlaceholders, substituteTemplatePlaceholders } from '../web/agent-scaffold.js'

// Repo root = two levels up from src/__tests__/.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Template / skill trees that ship in the repo and get copied into a user's
// tree at install or first boot. They must never carry deployment-specific
// identity, because that value is seeded verbatim into every other install:
// an absolute home path breaks (it points at a user that does not exist on
// the target machine), and a personal email leaks one operator's account into
// everyone else's generated files. Identity must instead flow through
// placeholders that the installer and the runtime seed substitute per host.
//
// Only fully-shipped trees are listed. The repo's `skills/` dir is excluded
// on purpose: on a live operator checkout it also accumulates untracked,
// machine-specific skills, so a recursive scan there would fail locally for
// reasons unrelated to what ships. Its one tracked, shipped skill
// (skill-factory) is kept host-agnostic by hand instead.
const TEMPLATE_DIRS = ['scheduled-tasks', 'templates', 'seed-scheduled-tasks', 'seed-skills']

// The identity placeholders the runtime seed (resolveTemplatePlaceholders)
// substitutes, kept in sync with the install scripts' sed substitutions.
const KNOWN_PLACEHOLDERS = ['PROJECT_ROOT', 'INSTALL_DIR', 'MAIN_AGENT_ID', 'BOT_NAME', 'OWNER_NAME', 'WEB_PORT']

// An absolute macOS/Linux home path embeds a real username. The trailing
// slash is optional so a bare literal like "/Users/bob" at end of value is
// still caught. A `<...>` segment (e.g. /Users/<user>/marveen) is a doc
// placeholder, not a real path, so it is allowed. URL lines are skipped by the
// caller so a link like https://host/home/x is not mistaken for a home path.
// `Public` is excluded on purpose: `/mnt/c/Users/Public/...` is Windows' own
// fixed, universal shared-profile folder (identical on every Windows install,
// not tied to whoever is logged in) -- the windows-desktop-* skills use it
// deliberately as a WSL<->Windows drop location, it is not a leaked username.
const HOME_PATH_RX = /\/(Users|home)\/(?!<)(?!Public\b)[A-Za-z0-9._-]+/
// A personal mailbox baked into a shipped file would leak / break on every
// other install. example.com and the noreply providers are not listed.
// Linuxbrew's prefix is a fixed, universal path present identically on every
// machine that has it -- the same reason /mnt/c/Users/Public is exempted above.
// It sits under /home only by Homebrew's own convention and belongs to no user,
// so a PATH export mentioning it is not leaked identity.
const UNIVERSAL_HOME_PATH = /\/home\/linuxbrew\b/g
/** True when the line names a real user's home dir, linuxbrew aside. */
function hasHomePath(line: string): boolean {
  return HOME_PATH_RX.test(line.replace(UNIVERSAL_HOME_PATH, ''))
}

const PERSONAL_EMAIL_RX = /[A-Za-z0-9._%+-]+@(gmail|outlook|icloud|yahoo|hotmail)\.[A-Za-z]+/i

// The canonical default OWNER_NAME from src/config.ts (`?? 'Szabolcs'`) and its
// common Hungarian nickname (Szabi). It is one specific deployment's operator
// name, so it must never be baked into a shipped template as a bare literal --
// the placeholder {{OWNER_NAME}} carries it per host. Catching the literal
// stops the exact regression where a task addresses the wrong person ("<owner>
// is asleep", "escalate to <owner>") on every other install. No trailing \b:
// the name takes Hungarian suffixes (Szabolcsnak, Szabihoz), and both the
// inflected full name and the nickname were among the leaks fixed here. The
// `(olcs|i)` after the shared `Szab` stem avoids common words like szabaly /
// szabad / szabas.
const FOREIGN_DEFAULT_OWNER_RX = /\bSzab(olcs|i)/i

// The name above is one specific deployment's operator. THIS checkout has an
// operator too, and baking their name into a shipped template is the same bug
// wearing different clothes -- it just cannot be caught by a fixed regex,
// because the name differs per install. So the rule is derived instead: read
// OWNER_NAME from .env and forbid that literal in shipped templates.
//
// The regression it pins (2026-08-11): seed-skills addressed the owner by name
// 151 times across 21 files, and the seed-skills install loop copied them with
// a plain `cp -r` -- no placeholder substitution at all, unlike the
// scheduled-task loop next to it. On anyone else's machine those skills told
// the agent to notify a person who does not exist there. The owner's own
// question was the right one: "mi van ha aki letelepiti azt ugy hivjak hogy
// geza. akkor nala nem fog mukodni?"
//
// Skipped when the value is missing, short, or the neutral placeholder from
// src/config.ts: a 1-2 character or generic name would match ordinary words and
// turn this into noise.
function currentOwnerNameLiteral(): string | null {
  const envText = readText(join(REPO_ROOT, '.env'))
  if (envText === null) return null
  const line = envText.split('\n').find(l => l.trim().startsWith('OWNER_NAME='))
  const value = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') ?? ''
  if (value.length < 3 || value.toLowerCase() === 'owner') return null
  return value
}

// A hardcoded numeric chat id (e.g. a Telegram chat id, 5+ digits) is one
// operator's personal channel. Seeded into a task it would make every other
// install post to that one person's chat. Use chat_id: 0 (the bound channel)
// or the {{CHAT_ID}} placeholder instead.
const HARDCODED_CHAT_ID_RX = /chat_id["':\s]+-?\d{5,}/i

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

describe('shipped templates carry no hardcoded identity', () => {
  it('has no absolute home path, personal email, default owner-name literal, or hardcoded chat id in any shipped template file', () => {
    const violations: string[] = []
    for (const dir of TEMPLATE_DIRS) {
      for (const file of walk(join(REPO_ROOT, dir))) {
        const text = readText(file)
        if (text === null) continue
        const rel = file.slice(REPO_ROOT.length + 1)
        text.split('\n').forEach((line, i) => {
          if (!line.includes('://') && hasHomePath(line)) {
            violations.push(`${rel}:${i + 1} absolute home path (use {{INSTALL_DIR}}): ${line.trim().slice(0, 100)}`)
          }
          if (PERSONAL_EMAIL_RX.test(line)) {
            violations.push(`${rel}:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
          }
          if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
            violations.push(`${rel}:${i + 1} default owner name literal (use {{OWNER_NAME}}): ${line.trim().slice(0, 100)}`)
          }
          if (HARDCODED_CHAT_ID_RX.test(line)) {
            violations.push(`${rel}:${i + 1} hardcoded numeric chat id (use chat_id: 0 or {{CHAT_ID}}): ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }
    expect(violations, `Hardcoded identity found in shipped templates:\n${violations.join('\n')}`).toEqual([])
  })

  it('does not bake THIS install\'s owner name into any shipped template', () => {
    const owner = currentOwnerNameLiteral()
    if (owner === null) return
    const ownerRx = new RegExp(`\\b${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
    const violations: string[] = []
    for (const dir of TEMPLATE_DIRS) {
      for (const file of walk(join(REPO_ROOT, dir))) {
        const text = readText(file)
        if (text === null) continue
        const rel = file.slice(REPO_ROOT.length + 1)
        text.split('\n').forEach((line, i) => {
          // A documentation address on a reserved example domain is a
          // placeholder, not identity -- and it stays a placeholder even when
          // the operator's name happens to be an ordinary English noun, which
          // is exactly how "boss@work.example" first tripped this check.
          if (/@[\w.-]*\bexample\b/i.test(line)) return
          if (ownerRx.test(line)) {
            violations.push(`${rel}:${i + 1} this install's owner name (use {{OWNER_NAME}}): ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }
    expect(violations, `This install's owner name is baked into shipped templates:\n${violations.join('\n')}`).toEqual([])
  })

  // web/app.js is the dashboard bundle, shipped verbatim to every install. It
  // must carry no deployment-specific operator identity: the owner display name
  // flows from the backend (OWNER_NAME -> /api/marveen -> window._marveen.ownerName,
  // read via chatOwnerName()), never a hardcoded "Szabolcs"/"Szabi" literal, so a
  // renamed install labels its real owner. This is the exact regression #369
  // fixed -- the chat sidebar used to pin/label the owner thread off a
  // `const CHAT_OWNER_AGENT = 'Szabolcs'` literal. The Marveen product brand and
  // agent role-names are NOT identity and stay allowed (none match these regexes).
  it('web/app.js carries no absolute home path, personal email, or default owner-name literal', () => {
    const violations: string[] = []
    const file = join(REPO_ROOT, 'web', 'app.js')
    const text = readText(file)
    if (text !== null) {
      text.split('\n').forEach((line, i) => {
        if (!line.includes('://') && HOME_PATH_RX.test(line)) {
          violations.push(`web/app.js:${i + 1} absolute home path: ${line.trim().slice(0, 100)}`)
        }
        if (PERSONAL_EMAIL_RX.test(line)) {
          violations.push(`web/app.js:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
        }
        if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
          violations.push(`web/app.js:${i + 1} default owner name literal (read it from window._marveen.ownerName via chatOwnerName()): ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(violations, `Hardcoded operator identity found in web/app.js:\n${violations.join('\n')}`).toEqual([])
  })

  // scripts/support-mail ships operator tooling that talks to a real mailbox.
  // It must carry no operator identity either: the mailbox address, vault key,
  // owner name and branding flow from config (.env) / {{...}} placeholders, so a
  // committed file must not bake in an absolute home path, a personal email, or
  // the default owner-name literal.
  it('scripts/support-mail carries no absolute home path, personal email, or default owner-name literal', () => {
    const violations: string[] = []
    for (const file of walk(join(REPO_ROOT, 'scripts', 'support-mail'))) {
      const text = readText(file)
      if (text === null) continue
      const rel = file.slice(REPO_ROOT.length + 1)
      text.split('\n').forEach((line, i) => {
        if (!line.includes('://') && HOME_PATH_RX.test(line)) {
          violations.push(`${rel}:${i + 1} absolute home path (derive from __file__): ${line.trim().slice(0, 100)}`)
        }
        if (PERSONAL_EMAIL_RX.test(line)) {
          violations.push(`${rel}:${i + 1} personal email: ${line.trim().slice(0, 100)}`)
        }
        if (FOREIGN_DEFAULT_OWNER_RX.test(line)) {
          violations.push(`${rel}:${i + 1} default owner name literal (use config / {{SUPPORT_SIGNATURE}}): ${line.trim().slice(0, 100)}`)
        }
      })
    }
    expect(violations, `Hardcoded identity found in scripts/support-mail:\n${violations.join('\n')}`).toEqual([])
  })
})

describe('runtime-seeded placeholders are all substituted', () => {
  // ensureDefaultScheduledTasks() copies scheduled-tasks/* into the user's
  // tree, running each file through resolveTemplatePlaceholders. Two ways this
  // could regress, each covered below.

  // 1. The seed stops substituting one of the identity placeholders (e.g. a
  // replaceAll line is deleted). Feeding every known placeholder through the
  // real function and asserting none survive exercises all five every run --
  // including {{OWNER_NAME}}/{{BOT_NAME}}, the highest-risk identity fields --
  // so it can never pass vacuously.
  it('resolveTemplatePlaceholders replaces every known identity placeholder', () => {
    const probe = KNOWN_PLACEHOLDERS.map(p => `{{${p}}}`).join('\n')
    const out = resolveTemplatePlaceholders(probe)
    const survivors = [...out.matchAll(/\{\{[A-Z_]+\}\}/g)].map(m => m[0])
    expect(
      survivors,
      `Known placeholders the seed failed to substitute: ${survivors.join(', ')}`,
    ).toEqual([])
  })

  // 2. A task template starts using a NEW placeholder the seed does not know
  // about, which would land verbatim ({{FOO}}) in the user's task. Assert
  // every placeholder actually used under scheduled-tasks/ is in the known
  // set. (Empty set is fine -- nothing to leak.)
  it('every placeholder used under scheduled-tasks/ is in the known set', () => {
    const used = new Set<string>()
    for (const file of walk(join(REPO_ROOT, 'scheduled-tasks'))) {
      const text = readText(file)
      if (text === null) continue
      for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) used.add(m[1])
    }
    const unknown = [...used].filter(p => !KNOWN_PLACEHOLDERS.includes(p))
    expect(
      unknown,
      `Placeholders used in scheduled-tasks/ that the seed does not substitute: ${unknown.join(', ')}`,
    ).toEqual([])
  })

  // The distributed updater (update.sh) ships to every install. Its
  // --reseed-fleet CLAUDE.md identity check detects stale-roster delegation
  // targets by comparing against the LOCAL agents/ dir at runtime, so the
  // script itself must never hard-code the origin fleet's roster names (or an
  // operator's identity) -- otherwise the shipped updater would re-introduce
  // exactly the leak it is meant to guard against. (The roster list lives here
  // in the test, never in shipped code.)
  // 3. Guard: templates/CLAUDE.md.template and src/web/agent-scaffold.ts must
  // use {{WEB_PORT}} / ${WEB_PORT} placeholders, not a hardcoded port literal.
  // A hardcoded localhost:3420 bypasses the substitution and breaks agents on
  // non-default ports (their memory/kanban/inter-agent API calls silently fail).
  it('CLAUDE.md.template contains no hardcoded localhost:3420', () => {
    const template = readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(template, 'templates/CLAUDE.md.template must use {{WEB_PORT}}, not localhost:3420').not.toContain('localhost:3420')
  })

  it('agent-scaffold.ts contains no hardcoded localhost:3420 in its generateClaudeMd prompt', () => {
    const scaffold = readFileSync(join(REPO_ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(scaffold, 'src/web/agent-scaffold.ts must use ${WEB_PORT}, not localhost:3420').not.toContain('localhost:3420')
  })

  it('install scripts write WEB_PORT into the generated .env (heredoc contains WEB_PORT line)', () => {
    for (const script of ['install-linux.sh', 'install-macos.sh']) {
      const src = readFileSync(join(REPO_ROOT, script), 'utf-8')
      // The .env heredoc block must contain a WEB_PORT= line so the runtime
      // dashboard reads the correct port from .env and matches what the
      // CLAUDE.md templates were seeded with at install time.
      expect(src, `${script}: .env heredoc must contain WEB_PORT= line`).toMatch(/WEB_PORT=/)
      // A --port CLI flag must exist so non-default-port installs are ergonomic.
      expect(src, `${script}: must accept a --port CLI flag`).toMatch(/--port/)
    }
  })

  it('substituteTemplatePlaceholders with non-default WEB_PORT seeds the correct port into CLAUDE.md.template', () => {
    const template = readFileSync(join(REPO_ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')
    const out = substituteTemplatePlaceholders(template, {
      projectRoot: '/test',
      mainAgentId: 'testbot',
      botName: 'TestBot',
      ownerName: 'TestOwner',
      webPort: 3421,
    })
    expect(out, 'substituted template must not contain localhost:3420').not.toContain('localhost:3420')
    expect(out, 'substituted template must not contain unresolved {{WEB_PORT}}').not.toContain('{{WEB_PORT}}')
    expect(out, 'substituted template must contain localhost:3421').toContain('localhost:3421')
  })

  it('update.sh stays host-agnostic (no hardcoded roster or operator identity)', () => {
    const updateSh = readFileSync(join(REPO_ROOT, 'update.sh'), 'utf8')
    for (const name of ['samu', 'zara', 'boni', 'iris', 'deeper', 'slacker']) {
      expect(
        new RegExp(`\\b${name}\\b`, 'i').test(updateSh),
        `update.sh hard-codes fleet roster name "${name}" -- it must compare against agents/ at runtime instead`,
      ).toBe(false)
    }
    for (const line of updateSh.split('\n')) {
      if (/https?:\/\//.test(line)) continue
      expect(hasHomePath(line), `update.sh embeds an absolute home path: ${line.trim()}`).toBe(false)
      expect(PERSONAL_EMAIL_RX.test(line), `update.sh embeds a personal email: ${line.trim()}`).toBe(false)
    }
  })

  // ---------------------------------------------------------------------
  // The shipped RUNTIME, not just the templates.
  //
  // The owner's instruction after the seed-skills leak (2026-08-11): "keszitsd
  // fel a marveen t hogy ilyen tobbet ne forduljon elo! kenyszeritsd ki hogy
  // mindig ugy kell egy fejlesztest megirni, valtozo nevekkel. tehat nem csak
  // itt a nevnel, hanem barhol mashol!" -- the point being that Marveen is open
  // source, so anything baked in works here and misbehaves on every install
  // that is not this one.
  //
  // Deliberately scoped to EXECUTABLE lines. A comment naming the person who
  // asked for a change is development history and breaks nothing; a string
  // literal naming them ships wrong behaviour. Tests are excluded too -- a
  // fixture id is data, not deployment identity.
  // ---------------------------------------------------------------------
  const RUNTIME_TREES = ['src', 'scripts', 'web']
  const RUNTIME_EXT = new Set(['.ts', '.js', '.py', '.sh', '.mjs'])
  const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/
  const SKIP_PART = new Set(['node_modules', 'dist', '__pycache__', 'store', '__tests__'])

  /**
   * Executable lines only. A comment naming a person is history; a string
   * literal naming them is behaviour. Python carries most of its documentation
   * in triple-quoted docstrings rather than `#` lines, so those blocks are
   * tracked and skipped too -- without this the check drowns in module headers
   * and gets switched off, which is how a rule stops protecting anything.
   */
  function codeLines(text: string, isPython: boolean): Array<{ line: string; n: number }> {
    const out: Array<{ line: string; n: number }> = []
    let inDoc = false
    text.split('\n').forEach((line, idx) => {
      if (isPython) {
        const fences = (line.match(/"""|'''/g) ?? []).length
        if (inDoc) {
          if (fences > 0) inDoc = false
          return
        }
        if (fences === 1) { inDoc = true; return }
        if (fences >= 2 && /^\s*("""|''')/.test(line)) return
      }
      if (COMMENT_LINE.test(line)) return
      out.push({ line, n: idx + 1 })
    })
    return out
  }

  function runtimeFiles(): string[] {
    const out: string[] = []
    for (const tree of RUNTIME_TREES) {
      for (const f of walk(join(REPO_ROOT, tree))) {
        const rel = f.slice(REPO_ROOT.length + 1)
        if (rel.split('/').some(part => SKIP_PART.has(part))) continue
        if (f.endsWith('.test.ts')) continue
        if (!RUNTIME_EXT.has(f.slice(f.lastIndexOf('.')))) continue
        out.push(f)
      }
    }
    return out
  }

  it('no executable line in src/, scripts/ or web/ hardcodes this install\'s identity', () => {
    const owner = currentOwnerNameLiteral()
    const envText = readText(join(REPO_ROOT, '.env')) ?? ''
    const envVal = (key: string): string => {
      const line = envText.split('\n').filter(l => l.trim().startsWith(`${key}=`)).pop()
      return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : ''
    }
    // Every identity this install configures. Whatever the value is here, it
    // must not appear as a literal in shipped, executable code.
    const identities = ([
      ['OWNER_NAME', owner ?? ''],
      ['MAIN_AGENT_ID', envVal('MAIN_AGENT_ID')],
      ['SERVICE_ID', envVal('SERVICE_ID')],
      ['GITHUB_PUSH_ACCOUNT', envVal('GITHUB_PUSH_ACCOUNT')],
    ] as Array<[string, string]>)
      .filter(([, v]) => v.length >= 3 && v.toLowerCase() !== 'owner' && v.toLowerCase() !== 'marveen')

    const violations: string[] = []
    for (const file of runtimeFiles()) {
      const text = readText(file)
      if (text === null) continue
      const rel = file.slice(REPO_ROOT.length + 1)
      for (const { line, n } of codeLines(text, file.endsWith('.py'))) {
        for (const [key, value] of identities) {
          if (new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line)) {
            violations.push(`${rel}:${n} hardcodes ${key} ("${value}") -- read it from config/.env instead: ${line.trim().slice(0, 90)}`)
          }
        }
      }
    }
    expect(violations, `Deployment identity baked into shipped code:\n${violations.join('\n')}`).toEqual([])
  })

  it('no executable line in src/, scripts/ or web/ hardcodes an absolute home path', () => {
    const violations: string[] = []
    for (const file of runtimeFiles()) {
      const text = readText(file)
      if (text === null) continue
      const rel = file.slice(REPO_ROOT.length + 1)
      for (const { line, n } of codeLines(text, file.endsWith('.py'))) {
        if (line.includes('://')) continue
        if (hasHomePath(line)) {
          violations.push(`${rel}:${n} absolute home path (derive it from PROJECT_ROOT / the script's own dir): ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(violations, `Absolute home paths baked into shipped code:\n${violations.join('\n')}`).toEqual([])
  })
})
