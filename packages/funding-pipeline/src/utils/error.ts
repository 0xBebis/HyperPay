/**
 * Funding Pipeline -- Error Utilities
 *
 * Structured error types and helpers for the funding state machine.
 * Every step wraps its errors with the step name so the top-level
 * catch can produce a meaningful error string for debugging.
 *
 * @packageDocumentation
 */

import type { FundingState, FundingJobData } from "../types";
import type { FundingLogger } from "../interfaces";

/**
 * Error thrown by a pipeline step.
 *
 * Wraps the underlying error with the step name and a formatted message,
 * making it easy to identify which step failed in logs and error handlers.
 */
export class FundingStepError extends Error {
  /** The pipeline step that produced this error (e.g. "bridging", "buying_credits"). */
  step: string;
  /** The original error that triggered this step failure. */
  cause?: any;

  /**
   * Create a new FundingStepError.
   *
   * @param step - The pipeline step name where the error occurred.
   * @param message - Human-readable error message.
   * @param cause - The original error that triggered this failure (optional).
   */
  constructor(step: string, message: string, cause?: any) {
    super(message);
    this.name = "FundingStepError";
    this.step = step;
    this.cause = cause;
  }
}

/**
 * Sentinel error thrown when a job has been cancelled mid-flight.
 *
 * The top-level catch in {@link FundingPipeline.run} treats this as a
 * non-retryable success (the job was intentionally stopped, not failed).
 */
export class JobCancelledError extends Error {
  /**
   * Create a new JobCancelledError.
   *
   * @param jobId - The ID of the cancelled job.
   */
  constructor(jobId: string) {
    super(`Funding job ${jobId} cancelled mid-flight`);
    this.name = "JobCancelledError";
  }
}

/**
 * Stringify any error into a single multi-line string capturing everything
 * needed to debug the failure without digging through worker logs.
 *
 * Extracts `message`, `shortMessage`, `code`, `status`/`statusCode`,
 * `response.data`, and `cause.message` from the error object.
 *
 * @param err - The error to format. Can be any type (Error, object, string, etc.).
 * @returns A pipe-separated string of error details, truncated to 800 chars per field.
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   logger.error(formatStepError(err));
 *   // => "Network timeout | code=ETIMEDOUT | status=408"
 * }
 * ```
 */
export function formatStepError(err: any): string {
  const parts: string[] = [];
  if (err?.message) parts.push(err.message);
  if (err?.shortMessage && err.shortMessage !== err?.message) {
    parts.push(`short=${err.shortMessage}`);
  }
  if (err?.code) parts.push(`code=${err.code}`);
  if (err?.status || err?.statusCode) {
    parts.push(`status=${err.status ?? err.statusCode}`);
  }
  if (err?.response?.data) {
    try {
      parts.push(
        `response=${JSON.stringify(err.response.data).slice(0, 800)}`,
      );
    } catch {
      parts.push(`response=${String(err.response.data).slice(0, 800)}`);
    }
  }
  if (err?.cause?.message && err.cause.message !== err.message) {
    parts.push(`cause=${err.cause.message}`);
  }
  if (parts.length === 0) {
    try {
      parts.push(JSON.stringify(err).slice(0, 800));
    } catch {
      parts.push(String(err));
    }
  }
  return parts.join(" | ");
}

/**
 * Run a single pipeline step with structured error wrapping and timing.
 *
 * Logs the step start and completion (with duration), and wraps any thrown
 * error as a {@link FundingStepError} tagged with the step name. Already-wrapped
 * errors are rethrown as-is.
 *
 * @typeParam T - The return type of the step function.
 * @param logger - Logger instance for step timing output.
 * @param jobData - The funding job data (used for log context).
 * @param step - The step name (a {@link FundingState} or "init").
 * @param fn - The async function to execute for this step.
 * @returns The result of the step function.
 * @throws {FundingStepError} If the step function throws (wraps the original error).
 *
 * @example
 * ```ts
 * const deposit = await runStep(logger, jobData, "waiting_deposit", () =>
 *   stepWaitForDeposit({ jobData, config, ... }),
 * );
 * ```
 */
export async function runStep<T>(
  logger: FundingLogger,
  jobData: FundingJobData,
  step: FundingState | "init",
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.info(
    `[funding] STEP START "${step}" — job=${jobData.jobId} agent=${jobData.agentId}`,
  );
  try {
    const result = await fn();
    logger.info(
      `[funding] STEP DONE  "${step}" (${Date.now() - startedAt}ms) — job=${jobData.jobId}`,
    );
    return result;
  } catch (err: any) {
    if (err instanceof FundingStepError) {
      logger.error(
        `[funding] STEP FAIL  "${step}" (${Date.now() - startedAt}ms) — already-wrapped: ${err.message}`,
      );
      throw err;
    }
    const formatted = formatStepError(err);
    logger.error(
      `[funding] STEP FAIL  "${step}" (${Date.now() - startedAt}ms) — job=${jobData.jobId}: ${formatted}`,
    );
    throw new FundingStepError(step, formatted, err);
  }
}
