// #431: sub-agents launch without the account-level claude.ai connectors so their
// tool schemas are not re-sent every turn; the main agent (channels.sh) keeps them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('sub-agent launch drops the claude.ai connectors (#431)', () => {
  const src = read('src/web/agent-process.ts')

  it('defines the switch and puts it into the actual launch command', () => {
    expect(src).toContain("const connectorsEnv = 'export ENABLE_CLAUDEAI_MCP_SERVERS=false && '")
    expect(src).toMatch(/\$\{promptSuggestionEnv\}\$\{connectorsEnv\}\$\{mcpEnv\}/)
  })

  it('the main agent launch script does not set it', () => {
    expect(read('scripts/channels.sh')).not.toContain('ENABLE_CLAUDEAI_MCP_SERVERS')
  })
})
