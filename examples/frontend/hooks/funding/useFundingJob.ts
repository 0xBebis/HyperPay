"use client";

/**
 * useFundingJob — live subscription to a backend agent funding job.
 *
 * Subscribes to the pubsub channel `funding.update.${jobId}` via the existing
 * SocketProvider. Each event from the backend queue worker becomes a state
 * update here, so the UI reflects the actual on-chain progress in real time
 * without polling.
 *
 * Also fetches the latest persisted snapshot from the API on mount and
 * whenever the jobId changes — this seeds the initial state so the UI
 * doesn't show "waiting..." for a couple of seconds before the first socket
 * event arrives.
 */

import { useEffect, useState } from "react";
import { agentFundingGetJob } from "@repo/api-client/agent-funding";
import { useSocket } from "@/providers/socket-provider";
import { useAuth } from "@/hooks/use-auth";

export type FundingState =
  | "waiting_deposit"
  | "bridging"
  | "swapping"
  | "buying_credits"
  | "confirming_credits"
  | "granting_credits"
  | "depositing_hl"
  | "complete"
  | "failed"
  | "cancelled";

export interface FundingJobStatus {
  jobId: string;
  state: FundingState;
  progress: number;
  message: string | null;
  error: string | null;
  txHashes: {
    deposit?: string | null;
    swap?: string | null;
    credits?: string | null;
    hlDeposit?: string | null;
  };
  /** True if the job is in a terminal state (complete or failed). */
  isTerminal: boolean;
}

interface SocketUpdatePayload {
  jobId: string;
  state: FundingState;
  progress: number;
  message?: string | null;
  txHashes?: {
    deposit?: string | null;
    swap?: string | null;
    credits?: string | null;
    hlDeposit?: string | null;
  };
}

const TERMINAL_STATES: ReadonlySet<FundingState> = new Set([
  "complete",
  "failed",
  "cancelled",
]);

/**
 * Channel format MUST match the backend `getFundingJobChannel(jobId, userId)`
 * in apps/api/src/queue/queues/agent-funding.queue.ts. The userId prefix is
 * required so the socket-server's channel auth (which scans for a UUID match
 * against the authenticated user) lets the owner subscribe.
 */
function getFundingJobChannel(jobId: string, userId: string): string {
  return `funding.update.${userId}.${jobId}`;
}

export function useFundingJob(jobId: string | null): FundingJobStatus | null {
  const { subscribe, isConnected } = useSocket();
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [status, setStatus] = useState<FundingJobStatus | null>(null);

  // Seed from the persisted DB row when the jobId changes (handles refresh
  // before the first socket event arrives).
  useEffect(() => {
    if (!jobId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await agentFundingGetJob(jobId);
        if (cancelled) return;
        const job = response?.data as any;
        if (!job) return;
        setStatus({
          jobId: job.job_id,
          state: job.state,
          progress: job.progress ?? 0,
          message: job.message ?? null,
          error: job.error ?? null,
          txHashes: {
            deposit: job.deposit_tx_hash,
            swap: job.swap_tx_hash,
            credits: job.credits_tx_hash,
            hlDeposit: job.hl_deposit_tx_hash,
          },
          isTerminal: TERMINAL_STATES.has(job.state as FundingState),
        });
      } catch {
        // Ignore — the socket subscription below will catch live events
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Subscribe to live updates from the backend queue worker
  useEffect(() => {
    if (!jobId || !isConnected || !userId) return;

    const channel = getFundingJobChannel(jobId, userId);
    const unsubscribe = subscribe<SocketUpdatePayload>(channel, (payload) => {
      if (!payload || payload.jobId !== jobId) return;
      setStatus({
        jobId: payload.jobId,
        state: payload.state,
        progress: payload.progress ?? 0,
        message: payload.message ?? null,
        error: null,
        txHashes: {
          deposit: payload.txHashes?.deposit ?? null,
          swap: payload.txHashes?.swap ?? null,
          credits: payload.txHashes?.credits ?? null,
          hlDeposit: payload.txHashes?.hlDeposit ?? null,
        },
        isTerminal: TERMINAL_STATES.has(payload.state),
      });
    });

    return () => {
      unsubscribe();
    };
  }, [jobId, isConnected, subscribe, userId]);

  return status;
}
