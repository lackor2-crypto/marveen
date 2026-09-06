// The embedding model's name, in ONE place.
//
// Kanban 5d0dfdc7: the setup wizard's Ollama step told the owner to run
// `ollama pull nomic-embed-text` -- with the name typed into BOTH translation
// files. A fork that changes the model would have kept advising the wrong pull
// command, in two languages, and every test would have stayed green: a
// translated sentence has no idea what the code embeds with.
//
// This is a LEAF module on purpose (no imports). The wizard registry is pure
// data and must not drag the database module in just to learn a model name;
// `src/db.ts` re-exports the constant, so existing importers are unaffected.
export const EMBED_MODEL = 'nomic-embed-text'
