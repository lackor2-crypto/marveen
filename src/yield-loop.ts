/** One turn of the event loop: pending requests and timers run before the caller continues (#988). */
export function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve) })
}
