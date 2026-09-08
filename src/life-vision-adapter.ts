// Valodi (tesseract/dlib) OCR- es arcfelismero-adapter a `life-inbox-analyze.ts`
// `OcrAdapter`/`FaceAdapter` interfeszehez -- Boss level-2 jovahagyasa utan
// (2026-09-08, Telegram) kotve be `initVisionAdapters()` hivassal a szerver
// inditasakor (`web.ts`). A ket eszkoz (tesseract-ocr + a dlib-alapu
// face_recognition) egy kulon, izolalt Python venv-ben fut
// (`scripts/install-vision.sh`), amit ez a modul csak subprocess-kent hiv.
//
// Ha a venv/eszkozok hianyoznak (friss telepites, vagy a jovahagyas meg nem
// tortent meg), `available()` false-t ad -- a hivo (`life-inbox-analyze.ts`)
// mar eleve keszult erre, a felhasznaloi szoveg is ezt magyarazza el.
import { existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { STORE_DIR, APP_LANG } from './config.js'
import { logger } from './logger.js'
import {
  setFaceAdapter, setOcrAdapter, T,
  type FaceAdapter, type FaceMatch, type OcrAdapter,
} from './life-inbox-analyze.js'

const VISION_DIR = process.env.MARVEEN_VISION_DIR || join(homedir(), '.local', 'share', 'marveen-vision')
const PYTHON = join(VISION_DIR, 'venv', 'bin', 'python')
const OCR_SCRIPT = join(VISION_DIR, 'ocr_extract.py')
const FACE_SCRIPT = join(VISION_DIR, 'face_recognize.py')
const FACE_ENROLL_SCRIPT = join(VISION_DIR, 'face_enroll.py')

/** `store/face-gallery/<personId>/*.jpg` -- referenciafotok szemelyenkent. */
export const FACE_GALLERY_DIR = join(STORE_DIR, 'face-gallery')

const SUBPROCESS_TIMEOUT_MS = 30_000

function ocrInstalled(): boolean {
  return existsSync(PYTHON) && existsSync(OCR_SCRIPT)
}

function faceInstalled(): boolean {
  return existsSync(PYTHON) && existsSync(FACE_SCRIPT)
}

export const realOcrAdapter: OcrAdapter = {
  available: ocrInstalled,
  extractText(absPath: string): string | null {
    if (!ocrInstalled()) return null
    const result = spawnSync(PYTHON, [OCR_SCRIPT, absPath], {
      timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8',
    })
    if (result.error || result.status !== 0) {
      if (result.error) logger.warn({ err: result.error, absPath }, 'OCR subprocess hiba')
      return null
    }
    const text = result.stdout.trim()
    return text || null
  },
}

export const realFaceAdapter: FaceAdapter = {
  available: faceInstalled,
  recognize(absPath: string): FaceMatch[] {
    if (!faceInstalled()) return []
    const result = spawnSync(PYTHON, [FACE_SCRIPT, absPath, FACE_GALLERY_DIR], {
      timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8',
    })
    if (result.error || result.status !== 0) {
      if (result.error) logger.warn({ err: result.error, absPath }, 'Arcfelismero subprocess hiba')
      return []
    }
    try {
      const parsed = JSON.parse(result.stdout.trim() || '[]')
      if (!Array.isArray(parsed)) return []
      return parsed.filter((m): m is FaceMatch =>
        typeof m?.personId === 'string' && typeof m?.confidence === 'number')
    } catch (err) {
      logger.warn({ err, absPath }, 'Arcfelismero valasz nem ertelmezheto JSON')
      return []
    }
  },
}

export interface FaceEnrollResult {
  ok: boolean
  savedPath?: string
  message: string
}

/**
 * Egy referenciafoto hozzaadasa a helyi arcfelismero galeriahoz. A
 * `/api/life/inbox/enroll-face` vegpont hasznalja: a felhasznalo egy mar
 * beerkezett fotot jelol ki, es kivalasztja kihez tartozik.
 */
export function enrollFace(absPhotoPath: string, personId: string, lang: string = APP_LANG): FaceEnrollResult {
  if (!existsSync(PYTHON) || !existsSync(FACE_ENROLL_SCRIPT)) {
    return {
      ok: false,
      message: T(lang,
        'A helyi arcfelismerő nincs telepítve, ezért fotót sem lehet hozzáadni a galériához.',
        'The local face recognizer is not installed, so no photo can be added to the gallery.'),
    }
  }
  mkdirSync(FACE_GALLERY_DIR, { recursive: true })
  const result = spawnSync(PYTHON, [FACE_ENROLL_SCRIPT, absPhotoPath, personId, FACE_GALLERY_DIR], {
    timeout: SUBPROCESS_TIMEOUT_MS, encoding: 'utf8',
  })
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || T(lang, 'ismeretlen hiba', 'unknown error')
    return {
      ok: false,
      message: T(lang,
        `Nem sikerült arcot találni a fotón, vagy hiba történt: ${detail}`,
        `Could not find a face in the photo, or an error occurred: ${detail}`),
    }
  }
  return {
    ok: true,
    savedPath: result.stdout.trim(),
    message: T(lang,
      'A referenciafotó elmentve, mostantól ez alapján is felismerhető.',
      'The reference photo has been saved, it can now be used for recognition.'),
  }
}

let wired = false

/**
 * Szerver-inditaskor hivando egyszer. Ha a venv/eszkozok nincsenek
 * telepitve (friss telepites vagy meg nem jovahagyott csomag), csendben
 * semmit nem csinal -- az alapertelmezett "nincs telepitve" adapterek
 * maradnak ervenyben (`unavailableOcrAdapter`/`unavailableFaceAdapter`).
 */
export function initVisionAdapters(): void {
  if (wired) return
  wired = true
  if (ocrInstalled()) {
    setOcrAdapter(realOcrAdapter)
    logger.info({ dir: VISION_DIR }, 'Helyi OCR-adapter bekotve')
  }
  if (faceInstalled()) {
    setFaceAdapter(realFaceAdapter)
    logger.info({ dir: VISION_DIR }, 'Helyi arcfelismero-adapter bekotve')
  }
}
