/**
 * X402 Client — Payment Payload Construction
 *
 * Creates and encodes the X402 payment payload from a signed authorization.
 * The payload is base64-encoded and sent in the X-Payment header.
 */

import type {
  SignedAuthorizationWithSig,
  TransferAuthorization,
  X402PaymentPayload,
} from "../types/protocol";
import { encodePaymentHeader } from "../types/utils";

/**
 * Create an X402 payment payload from a signed authorization.
 *
 * Combines the v, r, s signature components into a single hex string
 * and serializes the authorization fields as strings for JSON transport.
 *
 * @param signedAuth - The signed EIP-3009 authorization (output of {@link signTransferAuthorization}).
 * @param network - The blockchain network name (e.g., `"base"`).
 * @returns A fully formed {@link X402PaymentPayload} ready for encoding.
 * @throws {Error} If the `r` or `s` signature components are not valid 66-char hex strings.
 *
 * @example
 * ```typescript
 * const payload = createPaymentPayload(signedAuth, "base");
 * const header = encodePaymentHeader(payload);
 * ```
 */
export function createPaymentPayload(
  signedAuth: SignedAuthorizationWithSig,
  network: string,
): X402PaymentPayload {
  const authorization: TransferAuthorization = {
    from: signedAuth.from,
    to: signedAuth.to,
    value: signedAuth.value.toString(),
    validAfter: signedAuth.validAfter.toString(),
    validBefore: signedAuth.validBefore.toString(),
    nonce: signedAuth.nonce,
  };

  // Combine r + s + v into a single signature hex string
  if (
    typeof signedAuth.r !== "string" ||
    !signedAuth.r.startsWith("0x") ||
    signedAuth.r.length !== 66
  ) {
    throw new Error(`Invalid r component: expected 66-char hex string`);
  }
  if (
    typeof signedAuth.s !== "string" ||
    !signedAuth.s.startsWith("0x") ||
    signedAuth.s.length !== 66
  ) {
    throw new Error(`Invalid s component: expected 66-char hex string`);
  }
  const rWithout0x = signedAuth.r.slice(2);
  const sWithout0x = signedAuth.s.slice(2);
  const vHex = signedAuth.v.toString(16).padStart(2, "0");
  const fullSignature = `0x${rWithout0x}${sWithout0x}${vHex}`;

  return {
    x402Version: 1,
    scheme: "exact",
    network,
    payload: {
      signature: fullSignature,
      authorization,
    },
  };
}

/**
 * Create a complete X402 payment payload and encode it as a base64 string
 * suitable for the `X-Payment` HTTP header.
 *
 * This is a convenience function combining {@link createPaymentPayload} and
 * {@link encodePaymentHeader}.
 *
 * @param signedAuth - The signed EIP-3009 authorization.
 * @param network - The blockchain network name (e.g., `"base"`).
 * @returns The base64-encoded payment header string.
 *
 * @example
 * ```typescript
 * const header = createAndEncodePayment(signedAuth, "base");
 * await fetch(url, { headers: { "X-Payment": header } });
 * ```
 */
export function createAndEncodePayment(
  signedAuth: SignedAuthorizationWithSig,
  network: string,
): string {
  const payload = createPaymentPayload(signedAuth, network);
  return encodePaymentHeader(payload);
}
