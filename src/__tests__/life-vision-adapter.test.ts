import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi_mock_logger()
function vi_mock_logger() {
  // A logger.js valodi implementacioja fajlba ir -- teszt kozben nem kell.
}

const ORIGINAL_VISION_DIR = process.env.MARVEEN_VISION_DIR
let workDir: string

function fakePythonScript(behavior: 'ocr' | 'face' | 'enroll' | 'fail'): string {
  if (behavior === 'fail') {
    return '#!/bin/sh\nexit 1\n'
  }
  if (behavior === 'ocr') {
    return '#!/bin/sh\necho "FAKE_OCR_TEXT"\nexit 0\n'
  }
  if (behavior === 'face') {
    return '#!/bin/sh\necho \'[{"personId":"p1","confidence":0.87}]\'\nexit 0\n'
  }
  // enroll: prints the "saved path" the caller expects on stdout.
  return '#!/bin/sh\necho "$4/fake-saved.jpg"\nexit 0\n'
}

function installFakeVision(dir: string, opts: { ocrOk?: boolean; faceOk?: boolean; enrollOk?: boolean } = {}): void {
  const venvBin = join(dir, 'venv', 'bin')
  mkdirSync(venvBin, { recursive: true })
  // Egyetlen "python" binaris, ami az argv[1] (a script neve) alapjan dont.
  const pythonScript = [
    '#!/bin/sh',
    'case "$(basename "$1")" in',
    `  ocr_extract.py) ${opts.ocrOk === false ? 'exit 1' : 'echo "FAKE_OCR_TEXT"; exit 0'} ;;`,
    `  face_recognize.py) ${opts.faceOk === false ? 'exit 1' : 'echo \'[{"personId":"p1","confidence":0.87}]\'; exit 0'} ;;`,
    `  face_enroll.py) ${opts.enrollOk === false ? 'exit 1' : 'echo "$4/fake-saved.jpg"; exit 0'} ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n')
  writeFileSync(join(venvBin, 'python'), pythonScript)
  chmodSync(join(venvBin, 'python'), 0o755)
  writeFileSync(join(dir, 'ocr_extract.py'), '# fake')
  writeFileSync(join(dir, 'face_recognize.py'), '# fake')
  writeFileSync(join(dir, 'face_enroll.py'), '# fake')
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'marveen-vision-test-'))
  vi.resetModules()
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  if (ORIGINAL_VISION_DIR === undefined) delete process.env.MARVEEN_VISION_DIR
  else process.env.MARVEEN_VISION_DIR = ORIGINAL_VISION_DIR
  vi.resetModules()
})

describe('life-vision-adapter (nincs telepitve)', () => {
  it('available() false es extractText/recognize null/ures ha a venv nincs telepitve', async () => {
    process.env.MARVEEN_VISION_DIR = join(workDir, 'nem-letezik')
    const { realOcrAdapter, realFaceAdapter } = await import('../life-vision-adapter.js')
    expect(realOcrAdapter.available()).toBe(false)
    expect(realOcrAdapter.extractText('/tmp/whatever.png')).toBeNull()
    expect(realFaceAdapter.available()).toBe(false)
    expect(realFaceAdapter.recognize('/tmp/whatever.png')).toEqual([])
  })

  it('enrollFace ok:false, kétnyelvű üzenettel, ha az arcfelismero nincs telepitve', async () => {
    process.env.MARVEEN_VISION_DIR = join(workDir, 'nem-letezik')
    const { enrollFace } = await import('../life-vision-adapter.js')
    const hu = enrollFace('/tmp/photo.jpg', 'p1', 'hu')
    expect(hu.ok).toBe(false)
    expect(hu.message).toMatch(/arcfelismerő/)
    const en = enrollFace('/tmp/photo.jpg', 'p1', 'en')
    expect(en.ok).toBe(false)
    expect(en.message).toMatch(/face recognizer/)
  })
})

describe('life-vision-adapter (telepitve, sikeres alfolyamat)', () => {
  it('extractText a fake python stdout-jat adja vissza', async () => {
    installFakeVision(workDir)
    process.env.MARVEEN_VISION_DIR = workDir
    const { realOcrAdapter } = await import('../life-vision-adapter.js')
    expect(realOcrAdapter.available()).toBe(true)
    expect(realOcrAdapter.extractText('/tmp/doc.png')).toBe('FAKE_OCR_TEXT')
  })

  it('recognize a fake python JSON valaszat parse-olja', async () => {
    installFakeVision(workDir)
    process.env.MARVEEN_VISION_DIR = workDir
    const { realFaceAdapter } = await import('../life-vision-adapter.js')
    expect(realFaceAdapter.available()).toBe(true)
    expect(realFaceAdapter.recognize('/tmp/photo.jpg')).toEqual([{ personId: 'p1', confidence: 0.87 }])
  })

  it('enrollFace ok:true a mentett utvonallal sikeres esetben', async () => {
    installFakeVision(workDir)
    process.env.MARVEEN_VISION_DIR = workDir
    const { enrollFace } = await import('../life-vision-adapter.js')
    const result = enrollFace('/tmp/photo.jpg', 'p1', 'hu')
    expect(result.ok).toBe(true)
    expect(result.savedPath).toMatch(/fake-saved\.jpg$/)
    expect(result.message).toMatch(/mentve/)
  })
})

describe('life-vision-adapter (telepitve, hibas alfolyamat)', () => {
  it('extractText null-t ad, ha a subprocess elbukik', async () => {
    installFakeVision(workDir, { ocrOk: false })
    process.env.MARVEEN_VISION_DIR = workDir
    const { realOcrAdapter } = await import('../life-vision-adapter.js')
    expect(realOcrAdapter.extractText('/tmp/doc.png')).toBeNull()
  })

  it('recognize ures tombot ad, ha a subprocess elbukik', async () => {
    installFakeVision(workDir, { faceOk: false })
    process.env.MARVEEN_VISION_DIR = workDir
    const { realFaceAdapter } = await import('../life-vision-adapter.js')
    expect(realFaceAdapter.recognize('/tmp/photo.jpg')).toEqual([])
  })

  it('enrollFace ok:false-t ad, ha nem talal arcot (subprocess nem-nulla kilepokod)', async () => {
    installFakeVision(workDir, { enrollOk: false })
    process.env.MARVEEN_VISION_DIR = workDir
    const { enrollFace } = await import('../life-vision-adapter.js')
    const result = enrollFace('/tmp/photo.jpg', 'p1', 'en')
    expect(result.ok).toBe(false)
    expect(result.savedPath).toBeUndefined()
  })
})

describe('initVisionAdapters', () => {
  it('nem koti be az adaptereket, ha a venv nincs telepitve (marad az alapertelmezett)', async () => {
    process.env.MARVEEN_VISION_DIR = join(workDir, 'nem-letezik')
    const { initVisionAdapters } = await import('../life-vision-adapter.js')
    const { getOcrAdapter, getFaceAdapter } = await import('../life-inbox-analyze.js')
    initVisionAdapters()
    expect(getOcrAdapter().available()).toBe(false)
    expect(getFaceAdapter().available()).toBe(false)
  })

  it('beköti a valodi adaptereket, ha a venv telepitve van', async () => {
    installFakeVision(workDir)
    process.env.MARVEEN_VISION_DIR = workDir
    const { initVisionAdapters, realOcrAdapter, realFaceAdapter } = await import('../life-vision-adapter.js')
    const { getOcrAdapter, getFaceAdapter } = await import('../life-inbox-analyze.js')
    initVisionAdapters()
    expect(getOcrAdapter()).toBe(realOcrAdapter)
    expect(getFaceAdapter()).toBe(realFaceAdapter)
  })

  it('idempotens: masodik hivas nem dob hibat', async () => {
    installFakeVision(workDir)
    process.env.MARVEEN_VISION_DIR = workDir
    const { initVisionAdapters } = await import('../life-vision-adapter.js')
    initVisionAdapters()
    expect(() => initVisionAdapters()).not.toThrow()
  })
})
