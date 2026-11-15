// Rule blocks in CLAUDE.md carry a digest (#799); the full text lives in
// ~/.claude/rule-details/<key>.md. Tests that assert on the full wording of a
// rule read the CLAUDE.md text together with those detail files.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ruleDetailsDir } from '../../web/rule-digests.js'

export function withDetails(claudeMdText: string): string {
  const dir = ruleDetailsDir()
  if (!existsSync(dir)) return claudeMdText
  const parts = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(dir, f), 'utf-8'))
  return claudeMdText + '\n' + parts.join('\n')
}
