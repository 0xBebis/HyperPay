/**
 * X402 Server Module
 *
 * Server-side components for X402 payment processing:
 * - {@link X402PaymentLibrary} -- Core payment lifecycle (requirements, verification, settlement)
 * - {@link DefaultFacilitatorClient} -- HTTP client for the facilitator service
 * - {@link createX402Middleware} -- Drop-in Express middleware for payment-gated endpoints
 * - {@link PaymentPersistence} / {@link FacilitatorClient} -- Pluggable interfaces
 *
 * @module server
 */
export * from "./interfaces";
export { DefaultFacilitatorClient } from "./facilitator";
export { X402PaymentLibrary } from "./library";
export { createX402Middleware } from "./middleware";
