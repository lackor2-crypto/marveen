/**
 * #396 Phase 1 -- createBackup() on a throwaway install: the .mbk opens with the
 * key, carries every §3.1 item the fixture has (the four gaps of the old
 * backup.sh included), matches its own manifest hashes, and leaves out logs,
 * caches, Claude credentials and its own key.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup, BACKUP_NAME_RE, acquireBackupLock } from '../backup/create.js'
import { extractBackup, checkManifestHashes } from '../backup/extract.js'
import { generateRecoveryKey, readHeader } from '../backup/crypto.js'
import { getOrCreateKey } from '../backup/key-store.js'
import { inspectDatabaseFile } from '../backup/db-snapshot.js'
import { populatedInstall, emptyInstall, slugOf } from './backup-fixture.js'

const A = populatedInstall('create')
const key = getOrCreateKey(A.storeDir).key
const out = mkdtempSync(join(A.root, 'out-'))
const cleanup: string[] = [A.root]
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }) })

const res = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, outDir: out, encrypt: { kdfN: 1024 }, appCommit: 'test' })
const dir = mkdtempSync(join(A.root, 'x-'))
const opened = res.ok ? await extractBackup(res.file!, key, dir) : null
const has = (p: string) => existsSync(join(dir, p))

describe('createBackup', () => {
  it('produces an encrypted .mbk, 0600, with a proper name', () => {
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(res.name).toMatch(BACKUP_NAME_RE)
    expect(statSync(res.file!).mode & 0o777).toBe(0o600)
    expect(readFileSync(res.file!).toString('latin1')).not.toContain('TELEGRAM_BOT_TOKEN')
    expect(readHeader(res.file!).header.kind).toBe('manual')
    expect(readdirSync(out).filter((n) => n.endsWith('.partial'))).toEqual([])
  })

  it('leaves no staging dir and no lock behind', () => {
    expect(readdirSync(join(A.storeDir, 'tmp'))).toEqual([])
    expect(existsSync(join(A.storeDir, 'locks', 'backup.lock'))).toBe(false)
  })

  it('every file matches the manifest hash', () => {
    const h = checkManifestHashes(dir, opened!.manifest)
    expect(h).toEqual({ missing: [], mismatched: [] })
    expect(opened!.manifest.files.length).toBeGreaterThan(20)
  })

  it('the DB is a consistent single-file snapshot with the right counts', () => {
    const m = opened!.manifest
    expect(m.db?.integrityCheck).toBe('ok')
    expect(m.db?.counts.kanban_cards).toBe(5)
    expect(m.db?.counts.memories).toBe(7)
    expect(has('project/store/claudeclaw.db')).toBe(true)
    expect(has('project/store/claudeclaw.db-wal')).toBe(false)
    expect(inspectDatabaseFile(join(dir, 'project/store/claudeclaw.db')).integrity).toBe('ok')
  })

  it('gap 1: memories of the main agent (isolated dir), an isolated agent, the shared dir and store/accounts', () => {
    const slug = slugOf(A.projectRoot)
    expect(has(`config/main/projects/${slug}/memory/x.md`)).toBe(true)
    expect(has(`config/beta/projects/${slugOf(join(A.projectRoot, 'agents', 'beta'))}/memory/b.md`)).toBe(true)
    expect(has(`config/default/projects/${slug}/memory/old.md`)).toBe(true)
    expect(has(`config/account-acct1/projects/${slug}/memory/acct.md`)).toBe(true)
    expect(has('project/agents/alpha/memory/a.md')).toBe(true)
    const roots = opened!.manifest.roots
    expect(roots['config/main']).toEqual({ kind: 'main', base: 'home', rel: '.claude-marvin' })
    expect(roots['config/account-acct1']).toEqual({ kind: 'account', base: 'project', rel: 'store/accounts/acct1' })
  })

  it('gaps 2-4: life-tree, storage, cloud config, hand-made files', () => {
    for (const p of ['life-tree.json', 'life-mounts.json', 'storages.json', 'drive-sync.json', 'rclone/rclone.conf', 'knowledge/botond.md', 'folder-icons/a.png']) {
      expect(has(`project/store/${p}`), p).toBe(true)
    }
  })

  it('secrets, agents, skills, schedules, channels', () => {
    for (const p of [
      'project/.env', 'project/store/.dashboard-token', 'project/store/.vault-key', 'project/store/vault.json',
      'project/.claude/channels/telegram/.env', 'project/.claude/channels/telegram/access.json',
      'project/agents/alpha/CLAUDE.md', 'project/agents/alpha/agent-config.json',
      'project/agents/alpha/.claude/skills/s1/SKILL.md', 'project/agents/alpha/.claude/channels/telegram/.env',
      'home/.claude/skills/k1/SKILL.md', 'home/.claude/scheduled-tasks/t1/SKILL.md',
      'home/.config/systemd/user/marveen-dashboard.service',
    ]) expect(has(p), p).toBe(true)
  })

  it('leaves out logs, caches, pids, transcripts, Claude credentials and its own key', () => {
    const all = opened!.manifest.files.map((f) => f.path)
    expect(all.some((p) => p.endsWith('.log') || p.endsWith('.jsonl'))).toBe(false)
    expect(all.some((p) => p.includes('/cache/'))).toBe(false)
    expect(all.some((p) => p.endsWith('.pid'))).toBe(false)
    expect(all.some((p) => p.includes('.credentials.json') || p.includes('claude-login'))).toBe(false)
    expect(all.some((p) => p.endsWith('.backup-key'))).toBe(false)
    expect(all.some((p) => p.includes('other.service'))).toBe(false)
    expect(JSON.stringify(opened!.manifest)).not.toContain('NOT-IN-ARCHIVE')
  })

  it('records the old paths for the restore-side rewrite', () => {
    expect(opened!.manifest.pathHints.PROJECT_ROOT).toBe(A.projectRoot)
    expect(opened!.manifest.pathHints.projectSlug).toBe(slugOf(A.projectRoot))
    expect(opened!.manifest.agents).toEqual(['alpha', 'beta'])
  })

  it('a second backup while the lock is held is refused, not queued', async () => {
    const release = acquireBackupLock(A.storeDir, 'test')!
    try {
      const r = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, outDir: out, encrypt: { kdfN: 1024 } })
      expect(r).toMatchObject({ ok: false, error: 'locked' })
    } finally { release() }
  })

  it('a scheduled backup does not start while a restore is running', async () => {
    const f = emptyInstall('restoring')
    cleanup.push(f.root)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(f.storeDir, 'restore-in-progress.json'), '{}')
    const r = await createBackup({ kind: 'scheduled', ctx: f.ctx, recoveryKey: generateRecoveryKey(), encrypt: { kdfN: 1024 } })
    expect(r).toMatchObject({ ok: false, error: 'restore_in_progress' })
  })

  it('a fresh, empty install backs up without errors', async () => {
    const f = emptyInstall('fresh')
    cleanup.push(f.root)
    const r = await createBackup({ kind: 'manual', ctx: f.ctx, recoveryKey: generateRecoveryKey(), encrypt: { kdfN: 1024 } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(r.file!.startsWith(join(f.storeDir, 'backups'))).toBe(true)
  })
})
