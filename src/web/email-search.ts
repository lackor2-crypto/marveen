const MAX_EMAIL_SEARCH_LENGTH = 200

export function normalizeEmailSearchQuery(value: string | null): string {
  return (value ?? '').trim().slice(0, MAX_EMAIL_SEARCH_LENGTH)
}

// Gmail's IMAP SEARCH does whole-word matching, not substring -- and it
// does NOT fold accents itself (Boss, 2026-08-09: searching "videó" found
// nothing against an email whose actual word is "video"). Stripping
// combining diacritics from the query text (NFD decompose + drop marks)
// before it goes to himalaya makes "videó"/"video" equivalent without
// touching what's shown back in the search box.
export function foldDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function buildHimalayaSearchArgs(query: string): string[] {
  const pattern = JSON.stringify(foldDiacritics(query))
  return [
    'from', pattern,
    'or', 'to', pattern,
    'or', 'subject', pattern,
    'or', 'body', pattern,
    'order', 'by', 'date', 'desc',
  ]
}
