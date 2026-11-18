import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

// #932 (upstream #2187/#2216): the `claude mcp add|remove` calls and the connector DELETE (which rewrites ~/.claude.json and
// every .mcp.json) all touch the same config, so they must run one at a time. A fake `claude` on PATH records start/end
// events; nothing real runs.

const tmpRoot = mkdtempSync(join(tmpdir(), 'connectors-mcp-ser-'))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot,
}))

const logSpy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: logSpy, PRETTY_OPTIONS: {} }))

vi.mock('../web/vault.js', () => ({
  listSecrets: vi.fn(() => []),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  getSecret: vi.fn(() => null),
  getSecretsForEnv: vi.fn(() => ({})),
}))

writeFileSync(join(tmpRoot, 'mcp-catalog.json'), JSON.stringify([
  { id: 'fake-remote', name: 'Fake remote', type: 'remote', url: 'https://example.test/mcp', transport: 'http' },
]))

const binDir = mkdtempSync(join(tmpdir(), 'connectors-mcp-ser-bin-'))
writeFileSync(join(binDir, 'claude'), `#!/bin/sh
d="$FAKE_CLAUDE_DIR"
n=$(cat "$d/n" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/n"
echo "start $n" >> "$d/events"
if [ -f "$d/sleep" ]; then sleep "$(cat "$d/sleep")"; fi
echo "end $n" >> "$d/events"
exit 0
`)
chmodSync(join(binDir, 'claude'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath}`

const { tryHandleConnectors } = await import('../web/routes/connectors.js')

afterAll(() => {
  process.env.PATH = origPath
  delete process.env.FAKE_CLAUDE_DIR
  rmSync(binDir, { recursive: true, force: true })
  rmSync(tmpRoot, { recursive: true, force: true })
})

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  process.env.FAKE_CLAUDE_DIR = dir
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function events(): string[] { try { return readFileSync(join(dir, 'events'), 'utf-8').split('\n').filter(Boolean) } catch { return [] } }
const setSleep = (v: string) => writeFileSync(join(dir, 'sleep'), v)

async function call(method: string, path: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: {} })
  let status = 0
  let out = ''
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL('http://localhost' + path)
  await tryHandleConnectors({ req, res, path: url.pathname, method, url } as any)
  return { status, json: out ? JSON.parse(out) : null }
}

describe('claude mcp operations and the connector DELETE never overlap (#932)', () => {
  it('two overlapping adds run one after the other', async () => {
    setSleep('0.6')
    const a = call('POST', '/api/connectors', { name: 'one', type: 'http', url: 'https://example.test/1' })
    await vi.waitFor(() => expect(events()).toContain('start 1'), { timeout: 5000 })
    const b = call('POST', '/api/connectors', { name: 'two', type: 'http', url: 'https://example.test/2' })
    await sleep(250)
    expect(events()).toEqual(['start 1'])
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    expect(events()).toEqual(['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('a connector DELETE waits for a running claude mcp add before rewriting the config', async () => {
    const name = 'del-serial-1'
    const file = join(tmpRoot, '.mcp.json')
    writeFileSync(file, JSON.stringify({ mcpServers: { [name]: { command: 'x' } } }))
    setSleep('1')
    const add = call('POST', '/api/connectors', { name: 'busy-add', type: 'http', url: 'https://example.test/busy' })
    await vi.waitFor(() => expect(events()).toContain('start 1'), { timeout: 5000 })
    const del = call('DELETE', '/api/connectors/' + encodeURIComponent(name))
    await sleep(300)
    expect(readFileSync(file, 'utf-8')).toContain(name)
    expect(events()).not.toContain('end 1')
    const [a, d] = await Promise.all([add, del])
    expect(a.status).toBe(200)
    expect(d.status).toBe(200)
    expect(d.json).toEqual({ ok: true, removed: 1 })
    expect(readFileSync(file, 'utf-8')).not.toContain(name)
  })

  it('a connector DELETE over an unreadable config answers 404 and later CLI calls still run', async () => {
    const file = join(tmpRoot, '.mcp.json')
    writeFileSync(file, '{not json')
    try {
      setSleep('0')
      const d = await call('DELETE', '/api/connectors/del-missing-2')
      expect(d.status).toBe(404)
      const r = await call('POST', '/api/connectors', { name: 'after', type: 'http', url: 'https://example.test/after' })
      expect(r.status).toBe(200)
      expect(events()).toEqual(['start 1', 'end 1'])
    } finally {
      writeFileSync(file, '{}')
    }
  })
})
