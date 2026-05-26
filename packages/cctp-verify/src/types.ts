/**
 * CCTP Verification Types
 */

/** Result of a successful CCTP settlement verification. */
export interface CctpTransferResult {
  /** Transaction hash on the source chain (e.g., HyperEVM). */
  depositTxHash: string | null;
  /** Transaction hash on the destination chain (e.g., Base). */
  fillTxHash: string | null;
  /** Source-side nonce used for ordering and matching. */
  nonce: number;
  /** Whether the transfer is fully settled on the destination chain. */
  settled: boolean;
}

/** A deposit operation found on the source chain. */
export interface DepositOperation {
  /** Source chain transaction hash (may be null if not yet indexed). */
  hash: string | null;
  /** Source-side nonce — used to match with the destination fill. */
  nonce: number;
}

/** A fill operation found on the destination chain. */
export interface FillOperation {
  /** Destination chain transaction hash confirming the fill. */
  fillTxHash: string | null;
}

/** Configuration for the dual-poll verification loop. */
export interface VerificationConfig {
  /** Milliseconds between poll attempts (default: 2000). */
  pollingIntervalMs?: number;
  /** Maximum number of poll attempts before timeout (default: 150 = ~5 min at 2s). */
  maxAttempts?: number;
  /** Called on each poll iteration with current state. */
  onProgress?: (attempt: number, state: { depositFound: boolean; fillFound: boolean }) => void;
}
