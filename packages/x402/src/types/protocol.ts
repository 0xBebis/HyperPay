/**
 * X402 Payment Protocol — Unified Type Definitions
 *
 * Merges frontend and backend type definitions into a single source of truth.
 * Based on Coinbase's X402 specification: https://github.com/coinbase/x402
 */

// ============================================================================
// Protocol Version
// ============================================================================

/** Current version of the X402 payment protocol. */
export const X402_VERSION = 1;

// ============================================================================
// Enums
// ============================================================================

/**
 * Payment scheme controlling how the payment amount is interpreted.
 *
 * - `EXACT`: The client must pay exactly the requested amount.
 * - `UPTO`: The client authorizes up to the requested amount; the server may charge less.
 */
export enum PaymentScheme {
  /** Client pays exactly the requested amount. */
  EXACT = "exact",
  /** Client authorizes up to the requested amount. */
  UPTO = "upto",
}

/**
 * Supported blockchain networks for X402 payments.
 *
 * Each value corresponds to a key in the {@link NETWORK_REGISTRY}.
 */
export enum PaymentNetwork {
  /** Arbitrum One (chain ID 42161). */
  ARBITRUM = "arbitrum",
  /** Base mainnet (chain ID 8453). */
  BASE = "base",
  /** Base Sepolia testnet (chain ID 84532). */
  BASE_SEPOLIA = "base-sepolia",
  /** Ethereum mainnet (chain ID 1). */
  ETHEREUM = "ethereum",
  /** Avalanche C-Chain (chain ID 43114). */
  AVALANCHE = "avalanche",
  /** Polygon PoS (chain ID 137). */
  POLYGON = "polygon",
  /** Optimism mainnet (chain ID 10). */
  OPTIMISM = "optimism",
}

// ============================================================================
// Payment Requirements (from 402 response)
// ============================================================================

/**
 * A single payment option returned in a 402 response.
 *
 * Describes what the server requires to grant access to a resource:
 * the amount, network, destination address, and USDC contract details.
 */
export interface X402PaymentRequirement {
  /** Payment scheme (e.g., `"exact"` or `"upto"`). */
  scheme: PaymentScheme | string;
  /** Blockchain network for the payment (e.g., `"base"`, `"arbitrum"`). */
  network: PaymentNetwork | string;
  /** Maximum USDC amount required in atomic units (string representation of a bigint). */
  maxAmountRequired: string;
  /** The absolute URL of the protected resource. */
  resource: string;
  /** Human-readable description of the payment purpose. */
  description?: string;
  /** MIME type of the protected resource response. */
  mimeType: string;
  /** Optional JSON Schema describing the response body structure. */
  outputSchema?: object | null;
  /** The Ethereum address that will receive the payment. */
  payTo: string;
  /** Maximum time in seconds the server will wait for payment settlement. */
  maxTimeoutSeconds: number;
  /** The USDC token contract address on the target network. */
  asset: string;
  /** Additional EIP-712 domain info for the token contract. */
  extra?: {
    /** Token name for the EIP-712 domain (e.g., `"USD Coin"`). */
    name?: string;
    /** Token version for the EIP-712 domain (e.g., `"2"`). */
    version?: string;
  } | null;
}

/**
 * The HTTP 402 response body containing one or more accepted payment options.
 *
 * This is the top-level envelope returned to clients when a resource requires payment.
 */
export interface X402PaymentRequirements {
  /** X402 protocol version (currently `1`). */
  x402Version: number;
  /** Array of accepted payment options the client can fulfill. */
  accepts: X402PaymentRequirement[];
  /** Optional error message explaining why payment is required. */
  error?: string;
}

// ============================================================================
// EIP-3009 Transfer Authorization
// ============================================================================

/**
 * Internal representation of an EIP-3009 TransferWithAuthorization using native bigints.
 *
 * Used during signing before values are serialized to strings for JSON transport.
 */
export interface TransferAuthorizationInternal {
  /** The address authorizing the transfer (payer). */
  from: string;
  /** The recipient address. */
  to: string;
  /** The transfer amount in USDC atomic units. */
  value: bigint;
  /** Unix timestamp (seconds) after which the authorization becomes valid. */
  validAfter: bigint;
  /** Unix timestamp (seconds) before which the authorization is valid. */
  validBefore: bigint;
  /** A unique 32-byte hex nonce to prevent replay attacks. */
  nonce: string;
}

/**
 * JSON-serializable representation of an EIP-3009 TransferWithAuthorization.
 *
 * All numeric values are serialized as strings for safe JSON transport.
 */
export interface TransferAuthorization {
  /** The address authorizing the transfer (payer). */
  from: string;
  /** The recipient address. */
  to: string;
  /** The transfer amount in USDC atomic units (string representation). */
  value: string;
  /** Unix timestamp after which the authorization becomes valid (string representation). */
  validAfter: string;
  /** Unix timestamp before which the authorization is valid (string representation). */
  validBefore: string;
  /** A unique 32-byte hex nonce to prevent replay attacks. */
  nonce: string;
}

/**
 * ECDSA signature components from an EIP-712 typed data signature.
 */
export interface SignatureComponents {
  /** Recovery identifier (27 or 28). */
  v: number;
  /** First 32 bytes of the signature (`0x`-prefixed hex). */
  r: string;
  /** Second 32 bytes of the signature (`0x`-prefixed hex). */
  s: string;
}

/**
 * A fully signed EIP-3009 TransferWithAuthorization, combining the authorization
 * fields with the ECDSA signature components.
 */
export interface SignedAuthorizationWithSig
  extends TransferAuthorizationInternal,
    SignatureComponents {}

// ============================================================================
// Payment Payload (sent in X-Payment header)
// ============================================================================

/**
 * The payment payload sent by the client in the `X-Payment` HTTP header (base64-encoded).
 *
 * Contains the signed EIP-3009 authorization and combined ECDSA signature.
 */
export interface X402PaymentPayload {
  /** X402 protocol version (must be `1`). */
  x402Version: number;
  /** Payment scheme matching the server's requirement (e.g., `"exact"`). */
  scheme: string;
  /** Blockchain network the payment is for (e.g., `"base"`). */
  network: string;
  /** The signed payment data. */
  payload: {
    /** Combined ECDSA signature (`0x` + r + s + v, 130 hex chars). */
    signature: string;
    /** The EIP-3009 TransferWithAuthorization fields. */
    authorization: TransferAuthorization;
  };
}

// ============================================================================
// Payment Response
// ============================================================================

/**
 * Generic payment response returned by the server after processing a payment.
 */
export interface X402PaymentResponse {
  /** Whether the payment was processed successfully. */
  success: boolean;
  /** Error message if the payment failed, otherwise `null`. */
  error: string | null;
  /** The on-chain settlement transaction hash, or `null` if not settled. */
  txHash: string | null;
  /** The network identifier where settlement occurred, or `null`. */
  networkId: string | null;
}

// ============================================================================
// Payment Status
// ============================================================================

/**
 * Client-side payment flow status, used in React hooks and UI state management.
 *
 * Flow: `idle` -> `connecting` -> `checking_balance` -> `signing` -> `verifying` -> `success` (or `error`).
 */
export type X402PaymentStatus =
  | "idle"
  | "connecting"
  | "checking_balance"
  | "signing"
  | "verifying"
  | "success"
  | "error";

/** How the payment is being made: via a connected wallet or an AI agent. */
export type PaymentMethod = "wallet" | "agent";

// ============================================================================
// Server-Side Types
// ============================================================================

/**
 * Result of verifying an X402 payment signature.
 */
export interface X402VerificationResult {
  /** Whether the payment signature is cryptographically valid. */
  isValid: boolean;
  /** Human-readable reason the verification failed, or `null` if valid. */
  invalidReason: string | null;
  /** The payer's Ethereum address (populated on success). */
  payer?: string;
  /** The payment amount in atomic units (populated on success). */
  amount?: string;
}

/**
 * Result of settling an X402 payment on-chain.
 */
export interface X402SettlementResult {
  /** Whether the on-chain settlement succeeded. */
  success: boolean;
  /** Error message if settlement failed, otherwise `null`. */
  error: string | null;
  /** The on-chain transaction hash, or `null` if settlement failed. */
  txHash: string | null;
  /** The network identifier where settlement occurred, or `null`. */
  networkId: string | null;
  /** The payer's Ethereum address (populated on success). */
  payer?: string;
  /** The settled amount in atomic units (populated on success). */
  amount?: string;
}

/**
 * Stored payment configuration for a protected resource.
 *
 * Persisted by the server to reconstruct payment requirements on subsequent requests.
 */
export interface X402PaymentConfig {
  /** The type of resource being protected (e.g., "credit_purchase"). */
  resourceType: string;
  /** Optional identifier for the specific resource instance. */
  resourceId?: string;
  /** The API endpoint path for this resource. */
  endpointPath: string;
  /** Payment scheme (e.g., `"exact"`, `"upto"`). */
  scheme: string;
  /** Blockchain network name (e.g., `"base"`). */
  network: string;
  /** The EVM chain ID. */
  chainId: number;
  /** The USDC token contract address on the target network. */
  assetAddress: string;
  /** The token symbol (e.g., `"USDC"`). */
  assetSymbol: string;
  /** The number of decimals for the token (USDC = 6). */
  assetDecimals: number;
  /** The required payment amount in human-readable USDC. */
  amountRequiredUsdc: number;
  /** The Ethereum address to receive the payment. */
  payToAddress: string;
  /** Optional custom facilitator URL override. */
  facilitatorUrl?: string | null;
  /** Maximum time in seconds the server will wait for settlement. */
  maxTimeoutSeconds: number;
  /** Human-readable description of the payment purpose. */
  description: string;
  /** MIME type of the protected resource response. */
  mimeType: string;
  /** Optional JSON Schema describing the expected response body. */
  outputSchema?: Record<string, unknown> | null;
}

/**
 * Payment information attached to the request by the X402 middleware.
 *
 * Available on `req.x402Payment` after the middleware processes a payment.
 */
export interface X402PaymentInfo {
  /** The transaction ID from the persistence layer. */
  transactionId: string;
  /** Whether the payment signature was verified. */
  verified: boolean;
  /** Whether the payment was settled on-chain. */
  settled: boolean;
  /** The payer's Ethereum address. */
  payer?: string;
  /** The payment amount. */
  amount?: string | number;
  /** The on-chain settlement transaction hash. */
  txHash?: string;
  /** The network identifier where settlement occurred. */
  networkId?: string;
  /** `true` if access was granted via a previously completed payment. */
  existingPayment?: boolean;
  /** The access mode that granted access. */
  accessMode?: "permanent" | "per_use" | "subscription";
  /** ISO 8601 timestamp of the original payment (for existing payments). */
  paymentDate?: string;
  /** The USDC amount paid (for existing payments). */
  amountPaid?: number;
}

// ============================================================================
// Facilitator Protocol Types
// ============================================================================

/**
 * Request body sent to the facilitator's `/verify` endpoint.
 */
export interface X402FacilitatorVerifyRequest {
  /** The client's payment payload containing the signed authorization. */
  paymentPayload: X402PaymentPayload;
  /** The server's payment requirements to verify against. */
  paymentRequirements: X402PaymentRequirement;
}

/**
 * Request body sent to the facilitator's `/settle` endpoint.
 */
export interface X402FacilitatorSettleRequest {
  /** X402 protocol version (must be `1`). */
  x402Version: number;
  /** The client's payment payload containing the signed authorization. */
  paymentPayload: X402PaymentPayload;
  /** The server's payment requirements to settle against. */
  paymentRequirements: X402PaymentRequirement;
}

/**
 * Response body from the facilitator's `/verify` endpoint.
 */
export interface X402FacilitatorVerifyResponse {
  /** Whether the payment signature is valid. */
  isValid: boolean;
  /** Reason the verification failed (if applicable). */
  invalidReason?: string | null;
  /** The payer's Ethereum address (populated on success). */
  payer?: string;
  /** The payment amount in atomic units (populated on success). */
  amount?: string;
}

/**
 * Response body from the facilitator's `/settle` endpoint.
 */
export interface X402FacilitatorSettleResponse {
  /** Whether the on-chain settlement succeeded. */
  success: boolean;
  /** Error message if settlement failed. */
  error?: string | null;
  /** The on-chain transaction hash (if successful). */
  transaction?: string | null;
  /** The network identifier where settlement occurred. */
  networkId?: string | null;
  /** The payer's Ethereum address. */
  payer?: string;
  /** The settled amount in atomic units. */
  amount?: string;
}
