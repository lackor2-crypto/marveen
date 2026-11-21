/**
 * Was this thrown by a caller's broken request body, or by our own code?
 *
 * Until 2026-09-04 the dashboard's top-level catch could not tell: a POST
 * whose `content` field carried a raw newline or an unclosed quote blew up in
 * JSON.parse, and the caller got a 500 "Szerver hiba" with a log line holding
 * nothing but a character offset. Two writes were lost that way in one week
 * (a daily-log entry and a kanban POST) and neither sender could have noticed
 * -- `curl -s` exits 0 on a 500 just as happily as on a 200.
 *
 * A malformed body is a CLIENT error: 400, named route, no stack.
 */
export function isMalformedBodyError(err: unknown): boolean {
  return err instanceof SyntaxError && /JSON/i.test(String(err.message))
}

/**
 * #961: a body that is valid JSON but the wrong SHAPE (null, a number where text is expected, an array where an object
 * is) blew up inside a handler on `.trim()` / destructuring / `for..of` and answered 500 "Szerver hiba" -- 57 write
 * endpoints did this on a fuzz run. The shared cause is that no common place checks the shape; the top-level catch is
 * that place. Only a write request that carried a body can be the caller's fault, and only these V8 messages say
 * "the value was not what the code expected". Anything else stays a 500 (our own bug).
 */
const SHAPE_MESSAGES = [
  /^Cannot read propert(y|ies) of (null|undefined)/,
  /^Cannot destructure property .* as it is (null|undefined)/,
  /^Cannot destructure '.*' as it is (null|undefined)/,
  /is not a function$/,
  /is not iterable$/,
  /^Cannot use 'in' operator to search for/,
  /^The "[^"]+" argument must be of type string/,
]
export function isBodyShapeError(err: unknown, method: string | undefined, contentLength: string | undefined): boolean {
  if (!(err instanceof TypeError)) return false
  if (!method || !/^(POST|PUT|PATCH|DELETE)$/i.test(method)) return false
  if (!contentLength || contentLength === '0') return false
  return SHAPE_MESSAGES.some((re) => re.test(err.message))
}
