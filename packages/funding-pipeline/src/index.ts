/**
 * @cod3x/funding-pipeline -- CCTP-native multi-chain agent funding
 *
 * This package provides a state-machine-based pipeline for funding AI trading
 * agents with USDC across multiple chains via Circle CCTP. The pipeline
 * handles deposit detection, cross-chain bridging, credit purchases, and
 * exchange deposits -- all with idempotent retry semantics.
 *
 * @packageDocumentation
 */

export * from "./types";
export * from "./interfaces";
export { FundingPipeline } from "./pipeline";
export { FundingStepError, JobCancelledError, formatStepError, runStep } from "./utils";
