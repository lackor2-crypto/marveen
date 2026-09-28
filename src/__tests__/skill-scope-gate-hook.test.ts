// Kanban #438 (owner, 2026-09-28): a skill may only come into being with a
// decided scope, so the Overview self-check never has to ask about it later.
// The endpoints already refuse an unscoped skill; this gate covers the direct
// file writes (Write, heredoc, cp) that bypassed them.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'skill-scope-gate.py')

let dir = ''
let skills = ''

function run(tool: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const e: Record<string, string> = { ...process.env as Record<string, string>, ...env }
  if (!env.MARVEEN_SKILL_SCOPE_GATE) delete e.MARVEEN_SKILL_SCOPE_GATE
  return spawnSync('python3', [HOOK], { input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: input }), encoding: 'utf-8', env: e })
}
const md = (scope?: string) => `---\nname: x\ndescription: y\n${scope ? `scope: ${scope}\n` : ''}---\n# X\n`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skill-gate-'))
  skills = join(dir, '.claude', 'skills')
  mkdirSync(join(skills, 'unscoped'), { recursive: true })
  mkdirSync(join(skills, 'reviewed'), { recursive: true })
  writeFileSync(join(skills, 'unscoped', 'SKILL.md'), md())
  writeFileSync(join(skills, 'reviewed', 'SKILL.md'), md('review'))
  mkdirSync(join(dir, 'src-ok'), { recursive: true })
  mkdirSync(join(dir, 'src-bad'), { recursive: true })
  writeFileSync(join(dir, 'src-ok', 'SKILL.md'), md('personal'))
  writeFileSync(join(dir, 'src-bad', 'SKILL.md'), md())
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('skill-scope-gate: Write', () => {
  it('STOPS a new SKILL.md without scope (exit 2, HU+EN guidance)', () => {
    const r = run('Write', { file_path: join(skills, 'new', 'SKILL.md'), content: md() })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('TILTVA')
    expect(r.stderr).toContain('scope: personal')
    expect(r.stderr).toContain('scope: global')
  })
  it('STOPS scope: review from an agent (machine path only) and an unknown value', () => {
    expect(run('Write', { file_path: join(skills, 'n', 'SKILL.md'), content: md('review') }).status).toBe(2)
    expect(run('Write', { file_path: join(skills, 'n', 'SKILL.md'), content: md('maybe') }).status).toBe(2)
  })
  it('STOPS a scope line outside the front matter', () => {
    const r = run('Write', { file_path: join(skills, 'n', 'SKILL.md'), content: '---\nname: x\n---\nscope: global\n' })
    expect(r.status).toBe(2)
  })
  it('ALLOWS personal and global, also in seed-skills/', () => {
    expect(run('Write', { file_path: join(skills, 'n', 'SKILL.md'), content: md('personal') }).status).toBe(0)
    expect(run('Write', { file_path: join(dir, 'seed-skills', 'n', 'SKILL.md'), content: md('global') }).status).toBe(0)
  })
  it('ignores files that are not a SKILL.md in a skills folder', () => {
    expect(run('Write', { file_path: join(skills, 'n', 'notes.md'), content: 'x' }).status).toBe(0)
    expect(run('Write', { file_path: join(dir, 'docs', 'SKILL.md'), content: 'x' }).status).toBe(0)
  })
  it('kill switch MARVEEN_SKILL_SCOPE_GATE=0 allows', () => {
    expect(run('Write', { file_path: join(skills, 'n', 'SKILL.md'), content: md() }, { MARVEEN_SKILL_SCOPE_GATE: '0' }).status).toBe(0)
  })
})

describe('skill-scope-gate: Edit/MultiEdit judge the RESULT', () => {
  it('ALLOWS patching a machine-written review skill', () => {
    expect(run('Edit', { file_path: join(skills, 'reviewed', 'SKILL.md'), old_string: '# X', new_string: '# Y' }).status).toBe(0)
  })
  it('STOPS removing the scope line', () => {
    expect(run('Edit', { file_path: join(skills, 'reviewed', 'SKILL.md'), old_string: 'scope: review\n', new_string: '' }).status).toBe(2)
  })
  it('STOPS patching an unscoped skill without adding scope, ALLOWS the patch that adds it', () => {
    const f = join(skills, 'unscoped', 'SKILL.md')
    expect(run('Edit', { file_path: f, old_string: '# X', new_string: '# Y' }).status).toBe(2)
    expect(run('Edit', { file_path: f, old_string: 'description: y\n', new_string: 'description: y\nscope: personal\n' }).status).toBe(0)
    expect(run('MultiEdit', { file_path: f, edits: [{ old_string: 'description: y\n', new_string: 'description: y\nscope: global\n' }] }).status).toBe(0)
  })
})

describe('skill-scope-gate: Bash', () => {
  it('STOPS the exact heredoc shape that created the unscoped skills', () => {
    const cmd = `cat > ~/.claude/skills/PR-INVESTIGATION-WORKTREE/SKILL.md << 'EOF'\n---\nname: pr-investigation-worktree\ndescription: x\n---\n# X\nEOF`
    expect(run('Bash', { command: cmd }).status).toBe(2)
  })
  it('ALLOWS the same heredoc with scope: global', () => {
    const cmd = `cat > ~/.claude/skills/X/SKILL.md << 'EOF'\n---\nname: x\ndescription: x\nscope: global\n---\n# X\nEOF`
    expect(run('Bash', { command: cmd }).status).toBe(0)
  })
  it('STOPS tee into a SKILL.md without scope', () => {
    expect(run('Bash', { command: `printf -- '---\\nname: x\\n---\\n' | tee ${join(skills, 'n', 'SKILL.md')}` }).status).toBe(2)
  })
  it('judges cp by the SOURCE file', () => {
    mkdirSync(join(skills, 'dst'), { recursive: true })
    expect(run('Bash', { command: `cp src-bad/SKILL.md ${join(skills, 'dst', 'SKILL.md')}` }).status).toBe(2)
    expect(run('Bash', { command: `cp src-ok/SKILL.md ${join(skills, 'dst', 'SKILL.md')}` }).status).toBe(0)
    expect(run('Bash', { command: `cp -r src-bad ${join(skills, 'copied')}` }).status).toBe(2)
  })
  it('ALLOWS reading skills and making the folder', () => {
    expect(run('Bash', { command: `cat ${join(skills, 'unscoped', 'SKILL.md')}` }).status).toBe(0)
    expect(run('Bash', { command: 'mkdir -p ~/.claude/skills/new-one' }).status).toBe(0)
    expect(run('Bash', { command: 'ls ~/.claude/skills > /tmp/list.txt' }).status).toBe(0)
  })
})

describe('skill-scope-gate: wired and taught everywhere', () => {
  it('is registered for Write|Edit|MultiEdit|Bash in the fleet hook template', () => {
    const pre = JSON.parse(readFileSync(join(ROOT, 'templates', 'settings.json.template'), 'utf-8')).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>
    const e = pre.find(x => x.hooks.some(h => h.command.includes('skill-scope-gate.py')))
    expect(e).toBeTruthy()
    for (const t of ['Write', 'Edit', 'MultiEdit', 'Bash']) expect(e!.matcher.split('|')).toContain(t)
  })
  it('the skill-writing instructions carry the scope line (main template and agent scaffold)', () => {
    expect(readFileSync(join(ROOT, 'templates', 'CLAUDE.md.template'), 'utf-8')).toMatch(/description: [^\n]*\nscope: global\n---/)
    expect(readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')).toContain('frontmatter-t (name, description, scope)')
  })
})
