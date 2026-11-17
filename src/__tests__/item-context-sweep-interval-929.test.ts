// #929 (Boss, TG 6785): the item-context sweep walks every item on the slow F: drive, so it runs every 3 minutes (it was 2).
import { describe, it, expect } from 'vitest'
import { ITEM_CONTEXT_MS } from '../workbench-item-context.js'

describe('item context sweep interval', () => {
  it('is 3 minutes', () => { expect(ITEM_CONTEXT_MS).toBe(180_000) })
})
