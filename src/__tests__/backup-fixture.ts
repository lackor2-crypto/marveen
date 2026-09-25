/**
 * A throwaway Marveen install for the #396 backup/restore tests: a project
 * root, a store, a home dir with Claude config dirs, two agents (one on its own
 * isolated config dir) and a small database. Nothing here touches the real
 * install: every path is under a fresh temp dir.
 */
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InventoryContext } from '../backup/inventory.js'

export interface Fixture {
  root: string
  projectRoot: string
  storeDir: string
  home: string
  ctx: InventoryContext
  put(path: string, content?: string | Buffer): string
}

export function slugOf(p: string): string {
  return p.replace(/[/.]/g, '-')
}

export function emptyInstall(label = 'a'): Fixture {
  const root = mkdtempSync(join(tmpdir(), `marveen-bk-${label}-`))
  const projectRoot = join(root, 'marveen')
  const storeDir = join(projectRoot, 'store')
  const home = join(root, 'home')
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'marveen', version: '1.29.0' }))
  const put = (p: string, content: string | Buffer = 'x') => {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
    return p
  }
  const ctx: InventoryContext = {
    projectRoot, storeDir, home, mainAgentId: 'marveen',
    mainConfigDir: join(home, '.claude'),
    agents: [],
  }
  return { root, projectRoot, storeDir, home, ctx, put }
}

export function makeDb(file: string, cards = 5, memories = 7): void {
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_cards (id TEXT PRIMARY KEY, title TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, agent_id TEXT);
    CREATE TABLE IF NOT EXISTS dashboard_users (id INTEGER PRIMARY KEY, username TEXT);
  `)
  const ic = db.prepare('INSERT INTO kanban_cards (id, title, status) VALUES (?, ?, ?)')
  for (let i = 0; i < cards; i++) ic.run(`c${i}`, `card ${i}`, 'planned')
  const im = db.prepare('INSERT INTO memories (content, agent_id) VALUES (?, ?)')
  for (let i = 0; i < memories; i++) im.run(`memory ${i}`, 'marveen')
  db.close()
}

/**
 * Install "A": everything the plan's gap list names, plus things that must
 * NOT be taken (logs, caches, Claude credentials, the backup key).
 */
export function populatedInstall(label = 'a'): Fixture {
  const f = emptyInstall(label)
  const { projectRoot: P, storeDir: S, home: H, put } = f
  const slug = slugOf(P)
  makeDb(join(S, 'claudeclaw.db'))
  put(join(P, '.env'), 'MAIN_AGENT_ID=marveen\nFOO=bar\n')
  put(join(S, '.dashboard-token'), 'tok')
  put(join(S, '.vault-key'), 'vk')
  put(join(S, 'vault.json'), '{"entries":[]}')
  put(join(S, 'google-tokens.json'), '{}')
  put(join(S, 'rclone', 'rclone.conf'), '[mega]\n')
  put(join(S, 'rclone', 'rclone.log'), 'log')
  put(join(S, 'autonomy-config.json'), '{}')
  put(join(S, 'life-tree.json'), '{"tree":1}')
  put(join(S, 'life-mounts.json'), JSON.stringify({ mounts: [{ path: join(P, 'mnt') }] }))
  put(join(S, 'storages.json'), '{}')
  put(join(S, 'drive-sync.json'), '{}')
  put(join(S, 'knowledge', 'botond.md'), 'k')
  put(join(S, 'folder-icons', 'a.png'), 'png')
  // must be left out:
  put(join(S, 'cache', 'big.bin'), Buffer.alloc(1000))
  put(join(S, 'dashboard.log'), 'log line')
  put(join(S, 'agent-audit.jsonl'), '{}\n')
  put(join(S, 'claude-login', 'x.json'), 'cred')
  put(join(S, 'dashboard.pid'), '123')
  put(join(S, '.backup-key'), '{"current":{"key":"NOT-IN-ARCHIVE"}}')
  put(join(S, 'accounts', 'acct1', 'projects', slug, 'memory', 'acct.md'), 'account memory')
  put(join(S, 'accounts', 'acct1', '.credentials.json'), 'cred')
  // channels
  put(join(P, '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=1')
  put(join(P, '.claude', 'channels', 'telegram', 'access.json'), '{}')
  put(join(P, '.claude', 'channels', 'telegram', 'bot.pid'), '99')
  // agents
  put(join(P, 'agents', 'alpha', 'CLAUDE.md'), '# alpha')
  put(join(P, 'agents', 'alpha', 'agent-config.json'), '{"model":"sonnet"}')
  put(join(P, 'agents', 'alpha', 'memory', 'a.md'), 'alpha memory')
  put(join(P, 'agents', 'alpha', '.claude', 'skills', 's1', 'SKILL.md'), 'skill')
  put(join(P, 'agents', 'alpha', '.claude', 'settings.json'), '{"hooks":{}}')
  put(join(P, 'agents', 'alpha', '.claude', 'channels', 'telegram', '.env'), 'TELEGRAM_BOT_TOKEN=2')
  put(join(P, 'agents', 'alpha', '.claude', 'channels', 'telegram', 'bot.pid'), '1')
  const betaCfg = join(H, '.claude-beta')
  put(join(P, 'agents', 'beta', 'CLAUDE.md'), '# beta')
  put(join(P, 'agents', 'beta', 'agent-config.json'), JSON.stringify({ claudeConfigDir: betaCfg }))
  put(join(betaCfg, 'projects', slugOf(join(P, 'agents', 'beta')), 'memory', 'b.md'), 'beta memory')
  put(join(betaCfg, '.credentials.json'), 'cred')
  // home: shared ~/.claude and the main agent's isolated dir
  put(join(H, '.claude', 'skills', 'k1', 'SKILL.md'), 'home skill')
  put(join(H, '.claude', 'scheduled-tasks', 't1', 'SKILL.md'), 'task')
  put(join(H, '.claude', 'projects', slug, 'memory', 'old.md'), 'old main memory')
  put(join(H, '.claude', 'projects', slug, 'session.jsonl'), 'transcript')
  put(join(H, '.claude', '.credentials.json'), 'cred')
  const mainCfg = join(H, '.claude-marvin')
  put(join(mainCfg, 'projects', slug, 'memory', 'MEMORY.md'), '- [x](x.md)')
  put(join(mainCfg, 'projects', slug, 'memory', 'x.md'), 'main memory')
  put(join(mainCfg, 'settings.json'), '{}')
  put(join(mainCfg, '.credentials.json'), 'cred')
  put(join(H, '.config', 'systemd', 'user', 'marveen-dashboard.service'), '[Unit]')
  put(join(H, '.config', 'systemd', 'user', 'other.service'), '[Unit]')
  f.ctx.mainConfigDir = mainCfg
  f.ctx.agents = [{ name: 'alpha', configDir: null }, { name: 'beta', configDir: betaCfg }]
  return f
}
