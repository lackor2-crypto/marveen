import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { voiceRows } from '../web/system-health.js'

// Kanban a0637863. Boss (uzenet 1125): "az is hiba, hogy te tevesztettel ...
// kuszoboljuk ki." A tevesztes: egy rosszul futtatott kezi szkriptbol jelentettem
// ki, hogy a beszed-szoveg atiro "nincs telepitve", holott a rendszer VALODI utja
// (a venv Python-ja + _vtools.py) vegig ott volt. A tartos kapu: a self-check EZT
// a ket fajlt nezi (foldi igazsag), es a statusz a feluleten latszik -- igy nem egy
// kezi proba, hanem a rendszer sajat utja donti el, telepitve van-e.

const ROOT = join(__dirname, '..', '..')

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-voice-hc-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('voiceRows: a beszed-szoveg atiro allapota a rendszer foldi igazsagabol', () => {
  it('mindket fajl megvan -> voice_stt_ok, status ok', () => {
    withDir((dir) => {
      const venv = join(dir, 'venv', 'bin', 'python')
      const vtools = join(dir, '_vtools.py')
      mkdirSync(join(dir, 'venv', 'bin'), { recursive: true })
      writeFileSync(venv, '')
      writeFileSync(vtools, '')
      const rows = voiceRows(venv, vtools)
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe('voice_stt_ok')
      expect(rows[0].status).toBe('ok')
    })
  })

  it('hianyzik a venv Python -> voice_stt_missing, status warn (nem bad)', () => {
    withDir((dir) => {
      const vtools = join(dir, '_vtools.py')
      writeFileSync(vtools, '')
      const rows = voiceRows(join(dir, 'venv', 'bin', 'python'), vtools)
      expect(rows[0].id).toBe('voice_stt_missing')
      expect(rows[0].status).toBe('warn')
    })
  })

  it('hianyzik a _vtools.py -> voice_stt_missing', () => {
    withDir((dir) => {
      const venv = join(dir, 'venv', 'bin', 'python')
      mkdirSync(join(dir, 'venv', 'bin'), { recursive: true })
      writeFileSync(venv, '')
      const rows = voiceRows(venv, join(dir, '_vtools.py'))
      expect(rows[0].id).toBe('voice_stt_missing')
      expect(rows[0].status).toBe('warn')
    })
  })

  it('a hianyzas SOHA nem piros: ajanlott/kenyelmi komponens, nem alap', () => {
    withDir((dir) => {
      const rows = voiceRows(join(dir, 'nincs', 'python'), join(dir, 'nincs.py'))
      expect(rows[0].status).not.toBe('bad')
    })
  })
})

describe('voiceRows: minden kepernyore kerulo szoveg ketnyelvu', () => {
  const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
  const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')
  const keys = [
    'health.voice_stt_ok',
    'health.voice_stt_ok_action',
    'health.voice_stt_missing',
    'health.voice_stt_missing_action',
  ]
  it('minden kulcs megvan a hu.js-ben es az en.js-ben is', () => {
    for (const k of keys) {
      expect(HU, `hianyzo HU kulcs: ${k}`).toContain(`'${k}'`)
      expect(EN, `hianyzo EN kulcs: ${k}`).toContain(`'${k}'`)
    }
  })
})
