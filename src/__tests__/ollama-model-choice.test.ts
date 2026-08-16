// Card 5e6d495b (memory classification) listed three findings. Two were fixed
// and the card moved on; the third was left in the code and the card still went
// to the waiting column:
//
//   "src/web/routes/memories.ts:123 -- a modellvalasztas
//    ollamaModels.find(m => m.includes('gemma4')) || ollamaModels[0]
//    Nincs 'gemma4' nevu modell (gemma2/gemma3 letezik), tehat ez az ag halott,
//    es a tartalek barmi lehet, ami eppen elsokent jon a listaban -- akar egy
//    vision- vagy code-modell is. Determinisztikus valasztas kellene."
//
// Measured 2026-08-16: still there, and in a SECOND place the card never
// mentioned (src/web/routes/migrate.ts:172). Live `ollama list` on this host
// returns qwen2.5:3b and nomic-embed-text -- so today the accident lands on the
// right model and nothing looks wrong. That is what makes it worth a test: the
// bug only shows up the day somebody pulls a second model, and then it shows up
// as "the classifier got worse", not as an error.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chooseCategorizeModel } from '../ollama-model-choice.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')

describe('choosing the model that classifies a memory', () => {
  it('picks the chat model on this machine, not the embedding one', () => {
    // The list exactly as the live Ollama returned it today.
    expect(chooseCategorizeModel(['qwen2.5:3b', 'nomic-embed-text:latest'])).toBe('qwen2.5:3b')
  })

  it('says "nothing" rather than handing memories to an embedding model', () => {
    expect(chooseCategorizeModel(['nomic-embed-text:latest'])).toBeNull()
    expect(chooseCategorizeModel([])).toBeNull()
  })

  it('gives the same answer whatever order the API listed them in', () => {
    const a = ['llama3.2:3b', 'qwen2.5:3b', 'mistral:7b']
    const b = ['mistral:7b', 'qwen2.5:3b', 'llama3.2:3b']
    expect(chooseCategorizeModel(a)).toBe(chooseCategorizeModel(b))
    // ...and it is a preference, not the accident of position.
    expect(chooseCategorizeModel(a)).toBe('qwen2.5:3b')
  })

  it('does not ask a code or vision model to classify prose', () => {
    expect(chooseCategorizeModel(['qwen2.5-coder:7b', 'llama3.2:3b'])).toBe('llama3.2:3b')
    expect(chooseCategorizeModel(['llava:13b', 'gemma3:4b'])).toBe('gemma3:4b')
    // Even when the unsuitable one is all there is.
    expect(chooseCategorizeModel(['qwen2.5-coder:7b', 'llava:13b'])).toBeNull()
  })

  it('still uses an unknown model rather than giving up (preference, not whitelist)', () => {
    expect(chooseCategorizeModel(['deepseek-r1:8b'])).toBe('deepseek-r1:8b')
    // Deterministic even among unknowns.
    expect(chooseCategorizeModel(['zephyr:7b', 'deepseek-r1:8b'])).toBe('deepseek-r1:8b')
  })

  it('prefers the smaller build of a family on a CPU-only host', () => {
    // The card measured this box: no GPU, 7.7 GB to the whole VM, and an
    // out-of-memory shutdown on 2026-08-12. Ties go to the lighter tag.
    expect(chooseCategorizeModel(['qwen2.5:7b', 'qwen2.5:3b'])).toBe('qwen2.5:3b')
  })

  it('survives junk in the model list instead of crashing the import', () => {
    expect(chooseCategorizeModel([null, undefined, '', '   ', 'qwen2.5:3b'])).toBe('qwen2.5:3b')
  })
})

describe('the dead branch cannot come back', () => {
  const files = ['web/routes/memories.ts', 'web/routes/migrate.ts', 'ollama-model-choice.ts']

  // Comments are allowed to name the bug -- that is how the next reader learns
  // what happened. Only the executable half is checked.
  const codeOf = (f: string): string =>
    readFileSync(join(SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('runs no code that names a model family that does not exist', () => {
    for (const f of files) {
      expect(codeOf(f), f).not.toMatch(/gemma4/)
    }
  })

  it('has both import paths asking the shared helper, not their own copy', () => {
    for (const f of ['web/routes/memories.ts', 'web/routes/migrate.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8')
      expect(src, f).toMatch(/chooseCategorizeModel\(/)
      // No local re-invention of the choice next to it.
      expect(src, f).not.toMatch(/\.find\((?:\(m[^)]*\)|m)\s*=>\s*m[.\w]*\.includes\('/)
    }
  })
})
