/**
 * #396 -- the backup inventory is an ALLOWLIST (plan §3.2): every store/ entry
 * must be consciously classified as "in the backup" or "left out".
 *
 * Two sources are checked:
 *   1. every `join(STORE_DIR, '<name>')` literal in src/ (so a developer who
 *      adds a new store file gets a red test until they classify it -- that
 *      is how the old backup.sh silently missed the life-tree, cloud config
 *      and account memories);
 *   2. a fixture store with the top-level layout of a real, long-running
 *      install.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyStoreEntry, STORE_INCLUDE, STORE_EXCLUDE } from '../backup/inventory.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('backup inventory coverage', () => {
  it('every store/<name> the source code uses is classified', () => {
    const names = new Set<string>()
    const re = /STORE_DIR,\s*['"`]([^'"`$]+)['"`]/g
    for (const f of tsFiles(SRC)) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(re)) names.add(m[1].split('/')[0])
    }
    expect(names.size).toBeGreaterThan(30)
    const unclassified = [...names].filter((n) => classifyStoreEntry(n) === 'unclassified').sort()
    expect(unclassified, 'Classify these in src/backup/inventory.ts (STORE_INCLUDE or STORE_EXCLUDE)').toEqual([])
  })

  it('the top-level layout of a long-running install is fully classified', () => {
    const fixture = [
      '*ledger*.db', '.agent-failures-gypsy', '.channel-keepalive', '.channel-last-respawn', '.cred-backup-win.json',
      '.cred-switch-state', '.dashboard-token', '.default-projects-seeded', '.deployed-sha', '.env.bak-20260808-130100',
      '.fleet-memgate-alert', '.fleet-parked-agents', '.git-tokens.json', '.github-tokens.json', '.google-auth-pending.json',
      '.google-live-check.json', '.last-btime', '.morning-last-sent', '.ratelimit-alert-state.json', '.subagent-retry',
      '.vault-key', '.win-home', '.backup-key', 'accounts', 'agent-audit.jsonl', 'agent-msg-failures.log',
      'agent-parity-alert.json', 'agent-taskstate', 'agent-wake.log', 'agents-desired.json', 'autonomy-config.json',
      'backups', 'browser', 'cache', 'channels.log', 'claude-login', 'claude-model-scan.json', 'claude-plans.json',
      'claudeclaw.db', 'claudeclaw.db-shm', 'claudeclaw.db-wal', 'claudeclaw.pid', 'code-bot-offset', 'code-bot-stt',
      'command-task-health.json', 'commit-push-dispatch.json', 'compaction-quality.jsonl', 'config-overrides.json',
      'context-broker.json', 'context-guard-last-pane-usalackor.txt', 'context-restart-gate-state.json',
      'context-restart-gate-status.json', 'context-restart-gate.json', 'costops-config.json.example',
      'cred-switch-watchdog.sh', 'dashboard.pid', 'dead-agent-reply-state.json', 'debate-log.jsonl', 'deleted-agents',
      'deploy.lock', 'drafts', 'drive-delete-queue.json', 'drive-quota.json', 'drive-skiplist.json',
      'drive-sync-failures.jsonl', 'drive-sync-paused-x-backup.json', 'drive-sync.json', 'egress-allowlist.json',
      'email-attachment-flags.json', 'email-fastpath-guard.state', 'email-rules.json', 'event-log.txt',
      'external-deletions.jsonl', 'external-deletions.jsonl.1', 'external-ops-last-run', 'folder-icons', 'git-askpass.sh',
      'git-readonly-kivetelek.json', 'git-sync.json', 'git-takaritas-2026-08-18.md', 'google-oauth-client.json',
      'google-tokens.json', 'kanban-audit-state.json', 'knowledge', 'life-archived.json', 'life-labels.json',
      'life-mounts.json', 'life-physical.json', 'life-tree-created.json', 'life-tree.json', 'life-tree.json.bak-case',
      'limit-wake-alive.json', 'limit-wake-state.json', 'locks', 'main-account.json', 'marveen-avatar.png',
      'mega-accounts.json', 'mega-quota.json', 'mt4-terminal-dir.txt', 'openrouter-manual.json', 'pending-patches',
      'persistent-windows-backups', 'photos', 'pipeline-runs', 'rate-limit-status', 'rclone', 'reflect-state.json',
      'schedule-last-run.json', 'schedule-tick-state.json', 'schedule-tick-state.json.1.2.x.tmp', 'storages.json',
      'terminal-input.json', 'update-finalize.sh', 'update.last-result', 'upstream-247-restrictions.json',
      'upstream-changes.json', 'upstream-fix-only-files.json', 'upstream-sync-status.json', 'vault-bindings.json',
      'vault.json', 'window-layout-repo', 'windows-settings', 'windows-settings-backups', 'tmp',
    ]
    const unclassified = fixture.filter((n) => classifyStoreEntry(n) === 'unclassified')
    expect(unclassified).toEqual([])
  })

  it('the backup key, the live sidecars and the Claude login are never included', () => {
    for (const n of ['.backup-key', 'claudeclaw.db-wal', 'claudeclaw.db-shm', 'claude-login', '.cred-backup-wsl.json', 'backups', 'cache']) {
      expect(classifyStoreEntry(n), n).toBe('exclude')
    }
  })

  it('no name is on both lists', () => {
    for (const n of STORE_INCLUDE) {
      const hit = STORE_EXCLUDE.find((e) => (typeof e === 'string' ? e === n : e.test(n)))
      // An include always wins in classifyStoreEntry; an overlap is a sign of
      // a careless exclude pattern, so name it.
      expect(hit, `${n} also matches exclude ${String(hit)}`).toBeUndefined()
    }
  })
})
