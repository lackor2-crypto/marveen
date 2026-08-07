// Boss 2026-08-07 (voice): nothing in the dashboard told a user which
// accounts/credentials Marveen actually has -- Claude Code auth, Telegram,
// Google, GitHub, OpenRouter, Groq are each wired up through their own,
// separate mechanism (install-time prompt, OAuth file, gh CLI, Vault) and a
// fresh install (or Boss himself) had no single place to see "what's
// connected, what isn't, how do I connect the rest". This is that single
// place -- a read-only status list, GET-only, new isolated file so it never
// touches the existing per-mechanism setup flows.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, TELEGRAM_BOT_TOKEN } from '../../config.js'
import { getSecret } from '../vault.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

function hasGithubTokens(): boolean {
  const p = join(PROJECT_ROOT, 'store', '.github-tokens.json')
  if (!existsSync(p)) return false
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return data && typeof data === 'object' && Object.keys(data).length > 0
  } catch {
    return false
  }
}

export async function tryHandleAccounts(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/accounts' && method === 'GET') {
    json(res, {
      core: [
        { id: 'claude-code', configured: true },
        { id: 'telegram', configured: TELEGRAM_BOT_TOKEN.trim() !== '' },
      ],
      optional: [
        { id: 'google', configured: existsSync(join(PROJECT_ROOT, 'store', 'google-token.json')) },
        { id: 'github', configured: hasGithubTokens() },
        { id: 'openrouter', configured: getSecret('openrouter-fleet-key') !== null },
        { id: 'groq-stt', configured: getSecret('groq-stt-key') !== null },
      ],
    })
    return true
  }

  return false
}
