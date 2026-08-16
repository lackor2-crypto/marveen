//
// Which local model gets asked to classify a memory -- decided once, in one
// place, for every caller that asks.
//
// Card 5e6d495b measured the classification path and wrote down a third finding
// that was never fixed: the choice was
//
//     models.find(m => m.includes('gemma4')) || models[0]
//
// There has never been a model called "gemma4" -- the families are gemma2 and
// gemma3 -- so the first half matched nothing, ever, and the real choice was
// always "whatever the Ollama API happened to list first". On this machine that
// currently lands on qwen2.5:3b and the classification works, which is exactly
// why the bug survived: it is invisible until someone pulls a second model.
// Pull a coder or a vision model and the same line starts handing memories to a
// model that cannot do the job -- no error, no log line, just quietly worse
// answers.
//
// Shared rather than copied because BOTH import paths asked the same question
// (routes/memories.ts and routes/migrate.ts) and the card only noticed one of
// them. Two copies drift, and the drift here is silent.
//

/**
 * Names that mean "this model cannot classify a paragraph of text", whatever
 * else it is good at. Matched case-insensitively as substrings, because Ollama
 * tags carry the family in the name (`qwen2.5-coder:7b`, `nomic-embed-text`).
 */
const UNSUITABLE = [
  'embed', 'rerank',                                   // vector models, no chat
  'llava', 'vision', 'moondream', 'clip',              // image models
  'coder', 'codellama', 'codegemma', 'starcoder',      // code models
  'guard', 'whisper',                                  // safety filter, speech
]

/**
 * Families that reliably answer a "reply with this JSON" instruction, best
 * first. Anything unlisted still gets used as a last resort -- this is a
 * preference, not a whitelist, so a newly pulled model is never ignored.
 */
const PREFERRED = ['qwen3', 'qwen2.5', 'llama3', 'gemma3', 'gemma2', 'mistral', 'phi4', 'phi3', 'qwen2']

/**
 * The model to classify with, or null when nothing installed can do it.
 *
 * Deterministic on purpose: the same installed set must always give the same
 * answer, whatever order the API listed it in. Ties inside a family are broken
 * by sorting the tag, which prefers the smaller build (`:3b` before `:7b`) --
 * deliberate on this host, which the card measured as CPU-only with 7.7 GB of
 * RAM and an out-of-memory shutdown already on its record.
 */
export function chooseCategorizeModel(models: readonly unknown[]): string | null {
  const usable = models
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    .map(m => m.trim())
    .filter(m => !UNSUITABLE.some(bad => m.toLowerCase().includes(bad)))
  if (usable.length === 0) return null

  for (const family of PREFERRED) {
    const hits = usable.filter(m => m.toLowerCase().includes(family)).sort()
    if (hits.length > 0) return hits[0]
  }
  return [...usable].sort()[0]
}
