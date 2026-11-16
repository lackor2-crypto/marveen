import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import {
  startSlowFsWatch, slowFsReport, _resetSlowFsWatch, _setSlowFsClock, noteFsCall, dirKey, SLOW_FS_MS,
} from '../web/slow-fs-watch.js'

// #929: the dashboard froze for 14 to 30 s while its main thread waited in p9_client_rpc (a call to the Windows host
// over a /mnt drive). Nothing named which synchronous call it was; this watch times them per operation and directory.
describe('#929 slow synchronous file calls on watched (Windows-drive) paths are timed and attributed', () => {
  afterEach(() => _resetSlowFsWatch())

  it('a call on a watched path is counted with its duration and, when slow, kept with its caller', () => {
    startSlowFsWatch({ prefixes: ['/proc/self/'] })
    let t = 0
    // Each call "takes" 400 ms on the fake clock: the first reading is the start, the second the end.
    _setSlowFsClock(() => (t += 200))
    fs.statSync('/proc/self/status')
    const r = slowFsReport()
    const b = r.worst.find((x) => x.op === 'statSync')!
    expect(b.calls).toBe(1)
    expect(b.slow).toBe(1)
    expect(b.maxMs).toBe(200)
    expect(r.slow[0].path).toBe('/proc/self/status')
    expect(r.slow[0].ms).toBe(200)
    expect(r.slow[0].caller.join('\n')).toContain('slow-fs-watch.test')
  })

  it('a call on any other path is passed through untimed, with the same result', () => {
    startSlowFsWatch({ prefixes: ['/proc/self/'] })
    expect(fs.existsSync('/etc')).toBe(true)
    expect(fs.readFileSync('/proc/self/stat', 'utf8').length).toBeGreaterThan(0)
    const r = slowFsReport()
    expect(r.worst.some((x) => x.op === 'existsSync')).toBe(false)
    expect(r.worst.some((x) => x.op === 'readFileSync')).toBe(true)
  })

  it('an error thrown by the call still propagates and the time is still counted', () => {
    startSlowFsWatch({ prefixes: ['/proc/self/'] })
    expect(() => fs.readFileSync('/proc/self/no-such-file-929')).toThrow(/ENOENT/)
    expect(slowFsReport().worst.find((x) => x.op === 'readFileSync')!.calls).toBe(1)
  })

  it('the original functions come back on reset', () => {
    const before = fs.statSync
    startSlowFsWatch({ prefixes: ['/proc/self/'] })
    expect(fs.statSync).not.toBe(before)
    _resetSlowFsWatch()
    expect(fs.statSync).toBe(before)
  })

  it('calls under the threshold are counted but not kept as slow', () => {
    noteFsCall('statSync', '/mnt/f/x/y', SLOW_FS_MS - 1)
    noteFsCall('statSync', '/mnt/f/x/y', SLOW_FS_MS)
    const r = slowFsReport()
    expect(r.worst[0].calls).toBe(2)
    expect(r.worst[0].slow).toBe(1)
    expect(r.slow.length).toBe(1)
  })

  it('the directory key is shortened to the first six segments', () => {
    expect(dirKey('/mnt/f/Marveen/Projektek/A/B/C/D/file.pdf')).toBe('/mnt/f/Marveen/Projektek/A/B')
  })
})
