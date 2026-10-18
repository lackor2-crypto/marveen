// IS THIS UPLOAD ALREADY IN THE LIFE TREE? (#706, owner TG 9859)
//
// The owner chose the automatic option: when a file is uploaded and the tree already holds the very same content,
// no second copy is written -- the project gets a link to the file that is there (the project-document link of #530).
//
// "The same" means the same size AND the same content hash, never the name. Two sources, both only READ:
//   - the document records (life-doc-ids): a record whose SHA-256 is current for its file, found by the SHA-256 the
//     upload already computed while it was streamed to disk;
//   - the copy index (life-dup-index): files of the same size with a current md5; the md5 of the upload is taken only
//     when something of that size exists (the index walk hashes only files that share a size with another one).
// Honest limit: only files the index KNOWS (it runs in the background, started by the owner) and records that are
// current are looked at; a file outside both is NOT found and the upload goes in as a normal copy. "Not found" never
// means "checked everywhere".
import { statSync } from 'node:fs'
import { documentsByHash, hashFile } from './life-doc-ids.js'
import { indexedFilesOfSize } from './life-dup-index.js'
import { resolveLifePath } from './life-explorer.js'
import { logger } from './logger.js'
import type { StagedUpload } from './upload-stream.js'

/** How many same-size files without an index hash are read to compare (the rest stay unchecked). */
const MAX_UNHASHED = 20

/** The path must still be a file of exactly this size (a record can outlive its file). */
function stillThere(rel: string, size: number): boolean {
  try {
    const abs = resolveLifePath(rel)
    if (!abs) return false
    const st = statSync(abs)
    return st.isFile() && st.size === size
  } catch { return false }
}

/** The Life-tree path of a file with exactly the content of this staged upload, or null (none known). Never throws. */
export async function findLifeCopy(data: StagedUpload): Promise<string | null> {
  try {
    for (const d of documentsByHash(data.sha256)) {
      if (d.size === data.bytes && stillThere(d.rel, data.bytes)) return d.rel
    }
    const sameSize = indexedFilesOfSize(data.bytes)
    if (!sameSize.length) return null
    const { md5 } = await hashFile(data.path)
    // The index hashes only files that share a size with another one, so a lone same-size file has no md5 yet:
    // hash those on the spot (a handful at most -- same size AND same hash is still the only meaning of "same").
    let unhashed = 0
    for (const f of sameSize) {
      if (!stillThere(f.rel, data.bytes)) continue
      if (f.md5) {
        if (f.md5 === md5) return f.rel
        continue
      }
      if (++unhashed > MAX_UNHASHED) continue
      const abs = resolveLifePath(f.rel)
      if (abs && (await hashFile(abs)).md5 === md5) return f.rel
    }
  } catch (err) {
    logger.warn({ err: String((err as Error)?.message || err) }, '[upload-dup] the duplicate check failed; the file is uploaded as usual')
  }
  return null
}
