// Published DSH 0.1.2-rc.1 public interfaces. Keep host coupling in this adapter.
export { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm';
export { Session } from '@deepseek-ai/dsh-session';
export {
  CompactionEngine, ManualCompactionError, compactCheckpointSource,
  toolPairingBalancedBefore, toolPairingBalancedAfter,
} from '@deepseek-ai/dsh-compaction';
