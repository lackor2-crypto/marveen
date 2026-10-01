// The teardown helper for directories a real LibreOffice has written into
// (#456): it has to survive a writer that is still adding files while the
// recursive delete runs -- the exact failure measured on the main CI.
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmTempDir } from './helpers/rm-temp-dir.js'

describe('rmTempDir', () => {
  it('removes a plain directory tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-temp-dir-'))
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'f'), 'x')
    rmTempDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  it('a missing directory is not an error', () => {
    expect(() => rmTempDir(join(tmpdir(), 'rm-temp-dir-never-existed'))).not.toThrow()
  })

  it('waits out a process that is still writing into the tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-temp-dir-'))
    const pack = join(dir, 'lo-profile', 'user', 'pack')
    mkdirSync(pack, { recursive: true })
    // The writer only ADDS files to the existing directory (it never recreates
    // it), so once the delete wins the tree stays gone.
    const writer = spawn(process.execPath, ['-e', `
      const fs = require('fs'), path = require('path')
      const dir = ${JSON.stringify(pack)}
      const end = Date.now() + 400
      process.stdout.write('ready\\n')
      for (let i = 0; Date.now() < end; i++) { try { fs.writeFileSync(path.join(dir, 'f' + i), 'x') } catch {} }
    `], { stdio: ['ignore', 'pipe', 'ignore'] })
    const closed = new Promise<void>((resolve) => { writer.on('close', () => resolve()) })
    try {
      await new Promise<void>((resolve) => { writer.stdout!.once('data', () => resolve()) })
      expect(() => rmTempDir(dir)).not.toThrow()
      await closed
      expect(existsSync(dir)).toBe(false)
    } finally {
      await closed
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  it('still throws when the delete keeps failing for another reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rm-temp-dir-'))
    try {
      // NUL in a path is rejected outright -- not one of the "someone is still
      // writing" codes, so there must be no retry loop hiding it.
      const started = Date.now()
      expect(() => rmTempDir(join(dir, 'bad\0name'), { tries: 50, delayMs: 100 })).toThrow()
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
