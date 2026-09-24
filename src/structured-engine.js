// Legacy structured payload reader only. New writes, pricing and transactions
// belong exclusively to BasicCompactionEngine (via the summarize-only subclass).
export class StructuredCodexCompactionEngine {
  constructor(_ctx, { readCheckpoint, validateCheckpoint, estimateCheckpoint }) {
    if ([readCheckpoint, validateCheckpoint, estimateCheckpoint].some(fn => typeof fn !== 'function')) {
      throw new TypeError('Legacy reader requires owner read/validate/estimate codecs');
    }
    Object.assign(this, { readCheckpoint, validateCheckpoint, estimateCheckpoint });
  }
}
