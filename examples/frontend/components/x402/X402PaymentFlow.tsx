"use client";

/**
 * X402 Payment Flow Component
 * Terminal-themed payment UI for Web3 USDC payments
 */

import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Clock,
  Info,
  Loader2,
  Shield,
  Wallet,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useAccount, useConnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatefulButton, type ButtonState } from "@/components/ui/stateful-button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBotConfigs } from "@/hooks/bots/useBotConfigs";
import { useX402Payment } from "@/hooks/x402/useX402Payment";
import { cn } from "@/lib/utils";
import {
  atomicUnitsToUsdc,
  formatAddress,
  formatUSDC,
  getNetworkConfig,
  type PaymentMethod,
  type X402PaymentRequirements,
  type X402PaymentStatus,
} from "@/types/x402";

// ============================================================================
// Types
// ============================================================================

interface X402PaymentFlowProps {
  paymentRequirements: X402PaymentRequirements;
  onPaymentComplete: (paymentHeader: string) => void;
  onCancel?: () => void;
  resourceName?: string;
  resourceDescription?: string;
  hideMethodSelector?: boolean;
  defaultPaymentMethod?: PaymentMethod;
  className?: string;
}

interface PaymentDetails {
  amount: number;
  network: string;
  networkDisplayName: string;
  payToAddress: string;
  description: string;
  assetName: string;
  assetAddress: string;
  maxTimeoutSeconds: number;
  resource: string;
}

// ============================================================================
// Sub-components
// ============================================================================

function PaymentMethodCard({
  method,
  selected,
  onSelect,
  disabled,
  isConnected,
}: {
  method: PaymentMethod;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  isConnected?: boolean;
}) {
  const isWallet = method === "wallet";

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        "flex flex-col items-center gap-2 p-4 border font-mono transition-all",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal-cyan",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        selected
          ? "border-signal-cyan bg-signal-cyan/10 shadow-[0_0_12px_rgba(0,255,255,0.15)]"
          : "border-terminal-line bg-terminal-elevated hover:border-text-secondary"
      )}
      aria-pressed={selected}
      aria-label={isWallet ? "Pay with your wallet" : "Pay with agent wallet"}
    >
      <div
        className={cn(
          "w-10 h-10 flex items-center justify-center border transition-colors",
          selected
            ? "bg-signal-cyan/10 border-signal-cyan/30"
            : "bg-terminal-elevated border-terminal-line"
        )}
      >
        {isWallet ? (
          <Wallet
            className={cn(
              "w-5 h-5",
              selected ? "text-signal-cyan" : "text-text-secondary"
            )}
          />
        ) : (
          <Bot
            className={cn(
              "w-5 h-5",
              selected ? "text-signal-cyan" : "text-text-secondary"
            )}
          />
        )}
      </div>
      <div className="text-center">
        <p
          className={cn(
            "text-type-xs font-medium uppercase tracking-brand-wide",
            selected ? "text-text-bright" : "text-text-secondary"
          )}
        >
          {isWallet ? "Your Wallet" : "Agent Wallet"}
        </p>
        <p className="text-type-2xs text-text-secondary mt-0.5">
          {isWallet
            ? isConnected
              ? "Connected"
              : "Connect to pay"
            : "Use agent funds"}
        </p>
      </div>
    </button>
  );
}

function StatusIndicator({ status }: { status: X402PaymentStatus }) {
  const statusConfig: Record<
    X402PaymentStatus,
    {
      icon: React.ReactNode;
      text: string;
      alertVariant: "info" | "success" | "warning";
    }
  > = {
    idle: { icon: null, text: "", alertVariant: "info" },
    connecting: {
      icon: <Loader2 className="w-4 h-4 animate-spin-arc" />,
      text: "Connecting wallet...",
      alertVariant: "info",
    },
    checking_balance: {
      icon: <Loader2 className="w-4 h-4 animate-spin-arc" />,
      text: "Checking balance...",
      alertVariant: "info",
    },
    signing: {
      icon: <Loader2 className="w-4 h-4 animate-spin-arc" />,
      text: "Please sign in your wallet...",
      alertVariant: "warning",
    },
    verifying: {
      icon: <Loader2 className="w-4 h-4 animate-spin-arc" />,
      text: "Verifying payment...",
      alertVariant: "info",
    },
    success: {
      icon: <CheckCircle2 className="w-4 h-4" />,
      text: "Payment successful!",
      alertVariant: "success",
    },
    error: { icon: null, text: "", alertVariant: "info" },
  };

  const config = statusConfig[status];
  if (!config.icon) return null;

  return (
    <Alert variant={config.alertVariant} className="py-2" scanLines={false}>
      <AlertDescription className="flex items-center gap-2">
        {config.icon}
        <span>{config.text}</span>
      </AlertDescription>
    </Alert>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function X402PaymentFlow({
  paymentRequirements,
  onPaymentComplete,
  onCancel,
  resourceName = "this content",
  resourceDescription,
  hideMethodSelector = false,
  defaultPaymentMethod = "wallet",
  className,
}: X402PaymentFlowProps) {
  // Hooks
  const { address, isConnected, chain } = useAccount();
  const { connect, isPending: isConnecting } = useConnect();
  const { bots, isLoading: isLoadingBots } = useBotConfigs();
  const {
    handlePaymentRequired,
    paymentStatus,
    error: x402Error,
    resetPayment,
  } = useX402Payment();

  // Local state
  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>(defaultPaymentMethod);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState(false);

  // Filter bots with wallets
  const botsWithWallets = bots.filter((bot) => bot.eth_wallet);

  // Extract payment details
  const getPaymentDetails = (): PaymentDetails | null => {
    if (!paymentRequirements.accepts?.length) return null;

    const option = paymentRequirements.accepts[0];
    const amountInUsdc = atomicUnitsToUsdc(option.maxAmountRequired);
    const networkConfig = getNetworkConfig(option.network);

    return {
      amount: amountInUsdc,
      network: option.network,
      networkDisplayName: networkConfig?.displayName || option.network,
      payToAddress: option.payTo,
      description:
        option.description ||
        resourceDescription ||
        `Payment for ${resourceName}`,
      assetName: option.extra?.name || "USDC",
      assetAddress: option.asset,
      maxTimeoutSeconds: option.maxTimeoutSeconds,
      resource: option.resource,
    };
  };

  const paymentDetails = getPaymentDetails();

  // Handlers
  const handleWalletPayment = useCallback(async () => {
    if (!isConnected) {
      setLocalError(null);
      setPendingPayment(true);
      try {
        await connect({ connector: injected() });
      } catch (err) {
        console.error("Wallet connection error:", err);
        setLocalError(
          err instanceof Error ? err.message : "Failed to connect wallet"
        );
        setPendingPayment(false);
      }
      return;
    }

    setLocalError(null);

    try {
      const header = await handlePaymentRequired(paymentRequirements);
      await onPaymentComplete(header);
    } catch (err) {
      console.error("Payment error:", err);
      setLocalError(
        err instanceof Error
          ? err.message
          : "Payment failed. Please try again."
      );
    }
  }, [
    isConnected,
    connect,
    handlePaymentRequired,
    paymentRequirements,
    onPaymentComplete,
  ]);

  // Auto-proceed with payment after wallet connection
  useEffect(() => {
    if (pendingPayment && isConnected && paymentMethod === "wallet") {
      setPendingPayment(false);
      handleWalletPayment();
    }
  }, [pendingPayment, isConnected, paymentMethod, handleWalletPayment]);

  const handleAgentPayment = async () => {
    if (!selectedAgentId) {
      setLocalError("Please select an agent wallet");
      return;
    }

    const selectedAgent = botsWithWallets.find(
      (bot) => bot.id === selectedAgentId
    );
    if (!selectedAgent?.eth_wallet) {
      setLocalError("Selected agent has no wallet configured");
      return;
    }

    setLocalError(null);

    try {
      const header = await handlePaymentRequired(paymentRequirements, {
        accountName: selectedAgent.eth_wallet,
        address: selectedAgent.eth_wallet as `0x${string}`,
      });
      await onPaymentComplete(header);
    } catch (err) {
      console.error("Agent payment error:", err);
      setLocalError(
        err instanceof Error
          ? err.message
          : "Agent payment failed. Please try again."
      );
    }
  };

  const handlePayment = () => {
    if (paymentMethod === "wallet") {
      handleWalletPayment();
    } else {
      handleAgentPayment();
    }
  };

  const displayError = localError || x402Error;
  const isProcessing =
    paymentStatus === "connecting" ||
    paymentStatus === "checking_balance" ||
    paymentStatus === "signing" ||
    paymentStatus === "verifying";

  const payBtnState: ButtonState = isConnecting
    ? "pending"
    : isProcessing
      ? "pending"
      : paymentStatus === "success"
        ? "done"
        : displayError
          ? "error"
          : "idle";

  // Invalid requirements
  if (!paymentDetails) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center p-8 font-mono",
          className
        )}
      >
        <AlertCircle className="w-12 h-12 text-signal-red mb-3" />
        <p className="text-text-bright font-medium mb-1 uppercase tracking-brand-wide text-type-sm">
          Invalid Payment Requirements
        </p>
        <p className="text-type-xs text-text-secondary text-center">
          Unable to process payment. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4 font-mono", className)}>
      {/* Payment Method Selection */}
      {!hideMethodSelector && (
        <div className="space-y-3">
          <Label>Payment Method</Label>
          <div className="grid grid-cols-2 gap-3">
            <PaymentMethodCard
              method="wallet"
              selected={paymentMethod === "wallet"}
              onSelect={() => setPaymentMethod("wallet")}
              disabled={isProcessing}
              isConnected={isConnected}
            />
            <PaymentMethodCard
              method="agent"
              selected={paymentMethod === "agent"}
              onSelect={() => setPaymentMethod("agent")}
              disabled={isProcessing}
            />
          </div>

          {/* Agent Selector */}
          {paymentMethod === "agent" && (
            <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-fast">
              <Label htmlFor="agent-select">Select Agent</Label>
              {isLoadingBots ? (
                <div className="flex items-center justify-center p-3 bg-terminal-elevated border border-terminal-line">
                  <Loader2 className="w-4 h-4 animate-spin-arc text-text-secondary" />
                  <span className="ml-2 text-type-xs text-text-secondary">
                    Loading agents...
                  </span>
                </div>
              ) : botsWithWallets.length > 0 ? (
                <Select
                  value={selectedAgentId}
                  onValueChange={setSelectedAgentId}
                >
                  <SelectTrigger
                    id="agent-select"
                    className="rounded-none border-terminal-line bg-terminal-elevated font-mono"
                  >
                    <SelectValue placeholder="Choose an agent..." />
                  </SelectTrigger>
                  <SelectContent className="rounded-none border-terminal-line bg-terminal-surface">
                    {botsWithWallets.map((bot) => (
                      <SelectItem
                        key={bot.id}
                        value={bot.id}
                        className="rounded-none font-mono"
                      >
                        <div className="flex items-center gap-2">
                          <span>{bot.name}</span>
                          <Badge variant="default" size="sm">
                            {formatAddress(bot.eth_wallet!)}
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Alert
                  variant="warning"
                  className="py-2"
                  scanLines={false}
                >
                  <AlertDescription className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    No agents with wallets found. Please create an agent
                    first.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}

          {/* Wallet Connection Status */}
          {paymentMethod === "wallet" && isConnected && address && (
            <Alert variant="success" className="py-2" scanLines={false}>
              <AlertTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Wallet Connected
              </AlertTitle>
              <AlertDescription className="text-type-2xs font-mono truncate pl-6">
                {address}
              </AlertDescription>
            </Alert>
          )}

          {/* Network Info */}
          {paymentMethod === "wallet" && isConnected && chain && (
            <div className="flex items-center gap-2 p-3 bg-terminal-elevated border border-terminal-line">
              <Shield className="w-4 h-4 text-text-secondary" />
              <span className="text-type-xs text-text-secondary">
                Network:{" "}
                <span className="font-medium text-text-bright">
                  {chain.name}
                </span>
              </span>
              {chain.name.toLowerCase() !==
                paymentDetails.network.toLowerCase() && (
                <Badge variant="warning" size="sm" className="ml-auto">
                  Switch required
                </Badge>
              )}
            </div>
          )}
        </div>
      )}

      <Separator />

      {/* Payment Details */}
      <Card>
        <CardHeader className="px-3 py-2 bg-terminal-elevated space-y-1">
          <div className="flex items-center gap-2">
            <CircleDollarSign className="w-4 h-4 text-signal-cyan" />
            <span className="text-type-2xs uppercase tracking-brand-wide text-text-secondary">
              Payment Details
            </span>
          </div>
          <p className="text-type-2xs text-text-secondary pl-6">
            {paymentDetails.description}
          </p>
        </CardHeader>
        <CardContent className="p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-type-xs text-text-secondary uppercase tracking-brand-tight">Amount</span>
            <span className="text-type-xl font-bold text-signal-cyan tabular-nums">
              {formatUSDC(paymentDetails.amount)} {paymentDetails.assetName}
            </span>
          </div>

          <Separator />

          <div className="space-y-2 text-type-xs">
            <div className="flex items-center justify-between">
              <span className="text-text-secondary">Network</span>
              <Badge variant="default" size="sm" className="capitalize">
                {paymentDetails.networkDisplayName}
              </Badge>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-text-secondary">Recipient</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-type-2xs text-text-bright cursor-help">
                      {formatAddress(paymentDetails.payToAddress)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="rounded-none border-terminal-line bg-terminal-elevated">
                    <p className="font-mono text-type-2xs">
                      {paymentDetails.payToAddress}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                Valid for
              </span>
              <span className="font-medium text-text-bright">
                {paymentDetails.maxTimeoutSeconds}s
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* EIP-3009 Info */}
      <Alert variant="info" className="py-2" scanLines={false}>
        <AlertTitle className="flex items-center gap-2">
          <Info className="h-4 w-4 shrink-0" />
          Gasless Payment
        </AlertTitle>
        <AlertDescription className="text-type-2xs leading-relaxed pl-6">
          Using EIP-3009 signed authorization. You&apos;ll sign a message (no
          gas required), and the payment will be processed automatically.
        </AlertDescription>
      </Alert>

      {/* Status Indicator */}
      {paymentStatus !== "idle" && paymentStatus !== "error" && (
        <StatusIndicator status={paymentStatus} />
      )}

      {/* Error Message */}
      {displayError && (
        <Alert variant="error" className="py-2" scanLines={false}>
          <AlertTitle className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            Payment Error
          </AlertTitle>
          <AlertDescription className="text-type-2xs break-words whitespace-pre-wrap pl-6">
            {displayError}
          </AlertDescription>
        </Alert>
      )}

      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        {onCancel && (
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={isProcessing}
            className="flex-1 bg-terminal-elevated"
          >
            Cancel
          </Button>
        )}
        <StatefulButton
          state={payBtnState}
          onClick={handlePayment}
          disabled={paymentMethod === "agent" && !selectedAgentId}
          className="flex-1 bg-signal-cyan border-signal-cyan text-background hover:bg-signal-cyan/90 shadow-[0_0_20px_rgba(0,255,255,0.3)]"
          pendingLabel={
            isConnecting
              ? "Connecting..."
              : paymentStatus === "signing"
                ? "Sign in wallet..."
                : "Processing..."
          }
          doneLabel="Paid"
          errorLabel="Payment Failed"
          onRevert={() => {
            resetPayment();
            setLocalError(null);
          }}
        >
          {paymentMethod === "wallet" ? (
            <Wallet className="w-4 h-4" />
          ) : (
            <Bot className="w-4 h-4" />
          )}
          {paymentMethod === "wallet" && !isConnected
            ? "Connect & Pay"
            : `Pay ${formatUSDC(paymentDetails.amount)}`}
          <ArrowRight className="w-4 h-4" />
        </StatefulButton>
      </div>
    </div>
  );
}

export default X402PaymentFlow;
