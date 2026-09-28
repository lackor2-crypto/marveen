// Kanban #436 (owner, 2026-09-28): agents on a free (":free") model are
// READ-ONLY inside the install folder -- the machine stops the edit, the agent
// keeps running and can still read, test and use the API. Everything uncertain
// fails open, and a paid-model agent is never touched.
//
// The hook finds the install root from its own location, so each run copies it
// into a throwaway install with agents/<name>/agent-config.json.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'scripts', 'hooks', 'free-agent-read-only.py')

let inst = ''
let hook = ''
let outside = ''

function agent(name: string, model: string | null) {
  const d = join(inst, 'agents', name)
  mkdirSync(d, { recursive: true })
  if (model !== null) writeFileSync(join(d, 'agent-config.json'), JSON.stringify({ model }))
  return d
}

function run(who: string | null, tool: string, input: Record<string, unknown>, cwd?: string, env: Record<string, string> = {}) {
  const projectDir = who ? join(inst, 'agents', who) : inst
  const e: Record<string, string> = { ...process.env as Record<string, string>, CLAUDE_PROJECT_DIR: projectDir, ...env }
  delete e.MARVEEN_FREE_READONLY
  if (env.MARVEEN_FREE_READONLY) e.MARVEEN_FREE_READONLY = env.MARVEEN_FREE_READONLY
  return spawnSync('python3', [hook], {
    input: JSON.stringify({ tool_name: tool, cwd: cwd ?? projectDir, tool_input: input }),
    encoding: 'utf-8',
    env: e,
  })
}
const bash = (who: string | null, command: string, cwd?: string) => run(who, 'Bash', { command }, cwd)

beforeAll(() => {
  inst = mkdtempSync(join(tmpdir(), 'free-ro-'))
  mkdirSync(join(inst, 'scripts', 'hooks'), { recursive: true })
  hook = join(inst, 'scripts', 'hooks', 'free-agent-read-only.py')
  copyFileSync(SRC, hook)
  mkdirSync(join(inst, 'src'), { recursive: true })
  writeFileSync(join(inst, 'src', 'a.ts'), 'x\n')
  agent('freebie', 'nvidia/nemotron-3-super-120b-a12b:free')
  agent('paid', 'claude-opus-5-5')
  agent('glm', 'z-ai/glm-5v-turbo')
  agent('noconf', null)
  outside = mkdtempSync(join(tmpdir(), 'free-ro-out-'))
  writeFileSync(join(outside, 'o.txt'), 'x\n')
})

afterAll(() => {
  for (const d of [inst, outside]) if (d) rmSync(d, { recursive: true, force: true })
})

describe('free-agent-read-only: who is restricted (1A)', () => {
  it('STOPS the Edit of a :free agent inside the install (exit 2, HU+EN message)', () => {
    const r = run('freebie', 'Edit', { file_path: join(inst, 'src', 'a.ts') })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('TILTVA')
    expect(r.stderr).toContain('BLOCKED')
    expect(r.stderr).toContain('#436')
  })

  it('ALLOWS the same Edit for a paid model and for a non-free, non-Anthropic model', () => {
    expect(run('paid', 'Edit', { file_path: join(inst, 'src', 'a.ts') }).status).toBe(0)
    expect(run('glm', 'Edit', { file_path: join(inst, 'src', 'a.ts') }).status).toBe(0)
  })

  it('FAILS OPEN without agent-config.json, and for the main agent session', () => {
    expect(run('noconf', 'Write', { file_path: join(inst, 'src', 'a.ts') }).status).toBe(0)
    expect(run(null, 'Write', { file_path: join(inst, 'src', 'a.ts') }).status).toBe(0)
  })

  it('follows the CURRENT model: switching off :free lifts the block', () => {
    const d = agent('switcher', 'poolside/laguna-s-2.1:free')
    expect(run('switcher', 'Write', { file_path: join(inst, 'x.md') }).status).toBe(2)
    writeFileSync(join(d, 'agent-config.json'), JSON.stringify({ model: 'claude-sonnet-5' }))
    expect(run('switcher', 'Write', { file_path: join(inst, 'x.md') }).status).toBe(0)
  })

  it('kill switch MARVEEN_FREE_READONLY=0 allows', () => {
    const r = run('freebie', 'Edit', { file_path: join(inst, 'src', 'a.ts') }, undefined, { MARVEEN_FREE_READONLY: '0' })
    expect(r.status).toBe(0)
  })

  it('fails open on a garbage payload', () => {
    const r = spawnSync('python3', [hook], { input: 'not json', encoding: 'utf-8', env: { ...process.env, CLAUDE_PROJECT_DIR: join(inst, 'agents', 'freebie') } })
    expect(r.status).toBe(0)
  })
})

describe('free-agent-read-only: what is blocked (2A/3A)', () => {
  it('blocks every edit tool inside the install, including its own agent folder', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      expect(run('freebie', tool, { file_path: join(inst, 'agents', 'freebie', 'CLAUDE.md') }).status).toBe(2)
    }
    expect(run('freebie', 'NotebookEdit', { notebook_path: join(inst, 'n.ipynb') }).status).toBe(2)
  })

  it('allows edits OUTSIDE the install (scratch, /tmp)', () => {
    expect(run('freebie', 'Write', { file_path: join(outside, 'note.md') }).status).toBe(0)
  })

  it.each([
    'gh pr checkout 1633',
    'gh pr merge 12 --squash',
    'gh pr create --title x',
    'git checkout main',
    'git switch -c foo',
    'git commit -m x',
    'git push origin HEAD',
    'git merge origin/main',
    'git rebase main',
    'git reset --hard',
    'git add -A',
    'git stash',
    'git branch -D foo',
    `git -C ${'SUBDIR'} checkout main`,
    'cd src && git checkout .',
    'rm src/a.ts',
    'mv src/a.ts src/b.ts',
    'cp /etc/hostname src/',
    'touch new.txt',
    'mkdir newdir',
    "sed -i 's/x/y/' src/a.ts",
    "perl -pi -e 's/x/y/' src/a.ts",
    'echo hi > src/a.ts',
    'echo hi >> notes.md',
    'cat x | tee src/a.ts',
    'npm install',
    'bash scripts/land-pr.sh "t"',
    'scripts/deploy-live.sh',
    'curl -s -o src/a.ts http://x',
  ])('BLOCKS in Bash: %s', (cmd) => {
    const r = bash('freebie', cmd.replace('SUBDIR', inst), inst)
    expect(r.status, r.stderr).toBe(2)
  })

  it.each([
    'git status',
    'git log --oneline -5',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch',
    'git branch --contains HEAD',
    'git worktree list',
    'git stash list',
    'git fetch origin',
    'gh pr view 12',
    'gh pr diff 12',
    'gh pr list',
    'cat src/a.ts',
    'grep -rn x src',
    'npx vitest run src/__tests__/x.test.ts',
    'npx tsc --noEmit',
    'curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" http://localhost:3420/api/kanban',
    'ls -la 2>&1 | head',
    'echo x > /dev/null',
    "sed -n '1,5p' src/a.ts",
    'SUBOUT',
  ])('ALLOWS in Bash: %s', (cmd) => {
    const c = cmd === 'SUBOUT' ? `echo x > ${join(outside, 'o.txt')} && rm ${join(outside, 'o.txt')} && git -C ${outside} checkout x` : cmd
    const r = bash('freebie', c, inst)
    expect(r.status, r.stderr).toBe(0)
  })

  it('writes a deny line into store/agent-audit.jsonl', () => {
    bash('freebie', 'gh pr checkout 99', inst)
    const log = join(inst, 'store', 'agent-audit.jsonl')
    expect(existsSync(log)).toBe(true)
    const last = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'free-readonly-deny').pop()
    expect(last.agent).toBe('freebie')
    expect(last.model).toContain(':free')
    expect(last.target).toContain('gh pr checkout 99')
  })
})

describe('free-agent-read-only: wired for every agent (parity)', () => {
  it('is registered in templates/settings.json.template for Edit/Write/NotebookEdit/MultiEdit/Bash', () => {
    const tpl = readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')
    const pre = JSON.parse(tpl).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>
    const entry = pre.find(e => e.hooks.some(h => h.command.includes('free-agent-read-only.py')))
    expect(entry).toBeTruthy()
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash']) expect(entry!.matcher.split('|')).toContain(t)
  })
})
