"use client";

import { usePurchaseCredits } from "@repo/api-client/moonVaultApi";
import { useGetStakingDiscount } from "@repo/api-client/billing";
import {
  CreditCard,
  ExternalLink,
  Gift,
  Info,
  Loader2,
  Wallet,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useShake } from "@/hooks/ui/useShake";
import { useAccount, useConnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { CreditSlider } from "@/components/billing/CreditSlider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { X402PaymentFlow } from "@/components/x402";
import { trackCreditsPurchased } from "@/lib/analytics";
import { captureEvent } from "@/lib/analytics/posthog";
import {
  CREDIT_DEFAULT,
  getDiscountPercent,
  getPricePerHundred,
  getTotalPrice,
} from "@/lib/constants/credit-pricing";
import { cn } from "@/lib/utils";
import {
  NETWORK_CONFIGS,
  PaymentNetwork,
  type X402PaymentRequirements,
} from "@/types/x402";

type PaymentProvider = "coinbase" | "x402";

// X402 payment configuration for credit purchases
const createX402Requirements = (priceUsd: number): X402PaymentRequirements => {
  const networkConfig = NETWORK_CONFIGS[PaymentNetwork.BASE];
  const amountInAtomicUnits = Math.floor(priceUsd * 1_000_000).toString();
  const payToAddress = (process.env.NEXT_PUBLIC_X402_PAYMENT_ADDRESS ||
    "0x0000000000000000000000000000000000000000") as `0x${string}`;

  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: PaymentNetwork.BASE,
        maxAmountRequired: amountInAtomicUnits,
        resource: "/credits/purchase",
        description: `Purchase ${priceUsd} USD worth of AI credits`,
        mimeType: "application/json",
        payTo: payToAddress,
        maxTimeoutSeconds: 300,
        asset: networkConfig.usdcAddress,
        extra: {
          name: "USDC",
          version: "2",
        },
      },
    ],
    error: undefined,
  };
};

export function CreditPurchase() {
  const purchaseCreditsMutation = usePurchaseCredits();
  const { isConnected } = useAccount();
  const { connect, isPending: isConnecting } = useConnect();

  const [creditAmount, setCreditAmount] = useState(CREDIT_DEFAULT);
  const [promoCode, setPromoCode] = useState("");
  const [paymentProvider, setPaymentProvider] =
    useState<PaymentProvider>("coinbase");
  const [showX402Flow, setShowX402Flow] = useState(false);
  const { shakeProps, trigger: triggerShake } = useShake({ overlay: true });

  const price = getTotalPrice(creditAmount);
  const discount = getDiscountPercent(creditAmount);
  const perHundred = getPricePerHundred(creditAmount);
  const packageId = `credits-${creditAmount}`;

  // Personalized staking discount preview. Backend applies this on top of any
  // promo code, then caps combined discount at 50% (see billing.Controller.ts).
  // Backend math: Math.floor(price * pct / 100), mirrored here so the preview
  // matches the actual charge.
  const { data: stakingDiscount } = useGetStakingDiscount();
  const stakingPct = stakingDiscount?.discountPercent ?? 0;
  const stakingTier = stakingDiscount?.tier ?? null;
  const stakingDiscountAmount = Math.floor(price * (stakingPct / 100));
  const previewTotal = Math.max(0, price - stakingDiscountAmount);

  const handleCoinbasePurchase = async () => {
    captureEvent("credit-purchase-initiated", {
      provider: "coinbase",
      packageId,
      credits: creditAmount,
      price,
    });
    try {
      const result = await purchaseCreditsMutation.mutateAsync({
        data: {
          amount: price,
          packageId,
          discountCode: promoCode || undefined,
          paymentProvider: "coinbase",
        },
      });

      if (result.checkoutUrl) {
        captureEvent("credit-purchase-checkout", {
          provider: "coinbase",
          packageId,
          price,
        });
        window.open(result.checkoutUrl, "_blank");
        toast.success("Redirecting to checkout...");
      } else {
        captureEvent("credit-purchase-success", {
          provider: "coinbase",
          packageId,
          credits: creditAmount,
          price,
        });
        trackCreditsPurchased({
          amount_usd: price,
          package_id: packageId,
          payment_provider: "coinbase",
        });
        toast.success(
          `Successfully purchased ${creditAmount.toLocaleString()} credits!`
        );
      }
    } catch (error) {
      captureEvent("credit-purchase-failed", {
        provider: "coinbase",
        packageId,
        error: (error as Error).message,
      });
      toast.error(`Failed to purchase credits: ${(error as Error).message}`);
      triggerShake();
    }
  };

  const handleX402Purchase = () => {
    if (!isConnected) {
      connect({ connector: injected() });
      return;
    }
    setShowX402Flow(true);
  };

  const handleX402PaymentComplete = async (paymentHeader: string) => {
    try {
      const _result = await purchaseCreditsMutation.mutateAsync({
        data: {
          amount: price,
          packageId,
          discountCode: promoCode || undefined,
          paymentProvider: "coinbase",
          x402PaymentHeader: paymentHeader,
          isX402Payment: true,
        },
      });

      captureEvent("credit-purchase-success", {
        provider: "x402",
        packageId,
        credits: creditAmount,
        price,
      });
      trackCreditsPurchased({
        amount_usd: price,
        package_id: packageId,
        payment_provider: "x402",
      });
      toast.success(
        `Successfully purchased ${creditAmount.toLocaleString()} credits!`
      );
      setShowX402Flow(false);
    } catch (error) {
      captureEvent("credit-purchase-failed", {
        provider: "x402",
        packageId,
        error: (error as Error).message,
      });
      toast.error(`Failed to complete purchase: ${(error as Error).message}`);
      triggerShake();
    }
  };

  const handlePurchase = () => {
    if (paymentProvider === "coinbase") {
      handleCoinbasePurchase();
    } else {
      handleX402Purchase();
    }
  };

  // Show X402 payment flow
  if (showX402Flow) {
    return (
      <Card className="font-mono">
        <CardHeader className="px-4 py-2 bg-terminal-elevated">
          <div className="flex items-center gap-2">
            <Wallet className="w-4 h-4 text-signal-cyan" />
            <span className="text-type-2xs uppercase tracking-brand-wide text-text-secondary">
              Web3 Payment
            </span>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-type-xs text-text-secondary mb-4">
            Pay with USDC using your connected wallet
          </p>
          <X402PaymentFlow
            paymentRequirements={createX402Requirements(price)}
            onPaymentComplete={handleX402PaymentComplete}
            onCancel={() => setShowX402Flow(false)}
            resourceName={`${creditAmount.toLocaleString()} AI Credits`}
            resourceDescription={`Purchase ${creditAmount.toLocaleString()} credits for $${price.toFixed(2)}`}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("font-mono relative", shakeProps.className)} onAnimationEnd={shakeProps.onAnimationEnd}>
      {/* Header */}
      <CardHeader className="px-4 py-2 bg-terminal-elevated">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-cdx-electric" />
          <span className="text-type-2xs uppercase tracking-brand-wide text-text-secondary">
            Purchase Credits
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-5">
        {/* Payment Method Selection */}
        <div className="space-y-2">
          <Label>Payment Method</Label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setPaymentProvider("coinbase")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 border transition-all",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cdx-electric",
                paymentProvider === "coinbase"
                  ? "border-cdx-electric bg-cdx-electric/10 shadow-[0_0_12px_rgba(255,107,0,0.15)]"
                  : "border-terminal-line bg-terminal-elevated hover:border-text-secondary"
              )}
            >
              <div
                className={cn(
                  "w-10 h-10 flex items-center justify-center border transition-colors",
                  paymentProvider === "coinbase"
                    ? "bg-cdx-electric/10 border-cdx-electric/30"
                    : "bg-terminal-elevated border-terminal-line"
                )}
              >
                <CreditCard
                  className={cn(
                    "w-5 h-5",
                    paymentProvider === "coinbase"
                      ? "text-cdx-electric"
                      : "text-text-secondary"
                  )}
                />
              </div>
              <div className="text-center">
                <p
                  className={cn(
                    "text-type-xs font-medium uppercase tracking-brand-wide",
                    paymentProvider === "coinbase"
                      ? "text-text-bright"
                      : "text-text-secondary"
                  )}
                >
                  Card / Crypto
                </p>
                <p className="text-type-2xs text-text-secondary">
                  Coinbase Commerce
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setPaymentProvider("x402")}
              className={cn(
                "flex flex-col items-center gap-2 p-4 border transition-all",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-signal-cyan",
                paymentProvider === "x402"
                  ? "border-signal-cyan bg-signal-cyan/10 shadow-[0_0_12px_rgba(0,255,255,0.15)]"
                  : "border-terminal-line bg-terminal-elevated hover:border-text-secondary"
              )}
            >
              <div
                className={cn(
                  "w-10 h-10 flex items-center justify-center border transition-colors",
                  paymentProvider === "x402"
                    ? "bg-signal-cyan/10 border-signal-cyan/30"
                    : "bg-terminal-elevated border-terminal-line"
                )}
              >
                <Wallet
                  className={cn(
                    "w-5 h-5",
                    paymentProvider === "x402"
                      ? "text-signal-cyan"
                      : "text-text-secondary"
                  )}
                />
              </div>
              <div className="text-center">
                <p
                  className={cn(
                    "text-type-xs font-medium uppercase tracking-brand-wide",
                    paymentProvider === "x402"
                      ? "text-text-bright"
                      : "text-text-secondary"
                  )}
                >
                  Web3 Wallet
                </p>
                <p className="text-type-2xs text-text-secondary">
                  {isConnected ? "Connected" : "USDC on Base"}
                </p>
              </div>
              <Badge
                variant={paymentProvider === "x402" ? "info" : "default"}
                size="sm"
                className="-mt-1"
              >
                Gasless
              </Badge>
            </button>
          </div>
        </div>

        <Separator />

        {/* Credit Amount Selection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Credits</Label>
            <span className="text-type-sm font-bold text-cdx-electric tabular-nums">
              {creditAmount.toLocaleString()}
            </span>
          </div>

          <CreditSlider value={creditAmount} onChange={setCreditAmount} />
        </div>

        {/* Promo Code */}
        <div className="space-y-2">
          <Label htmlFor="promo-code">Promo Code</Label>
          <Input
            id="promo-code"
            type="text"
            placeholder="ENTER CODE"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            className="uppercase tracking-brand-wide"
            inputSize="sm"
          />
        </div>

        {/* Order Summary */}
        <Card className="bg-terminal-elevated">
          <CardHeader className="px-3 py-1.5">
            <span className="text-type-2xs uppercase tracking-brand-wide text-text-secondary">
              Order Summary
            </span>
          </CardHeader>
          <CardContent className="p-3 space-y-1.5">
            <div className="flex justify-between text-type-xs">
              <span className="text-text-secondary">Credits</span>
              <span className="font-bold text-text-bright tabular-nums">
                {creditAmount.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between text-type-xs">
              <span className="text-text-secondary">Rate</span>
              <span className="text-text-bright tabular-nums">
                ${perHundred.toFixed(2)}/100
              </span>
            </div>
            {discount >= 0.5 && (
              <div className="flex justify-between text-type-xs">
                <span className="text-signal-green">Volume discount</span>
                <span className="text-signal-green font-bold tabular-nums">
                  -{discount.toFixed(1)}%
                </span>
              </div>
            )}
            {promoCode && (
              <div className="flex justify-between text-type-xs">
                <span className="text-signal-green">Promo</span>
                <span className="text-signal-green">at checkout</span>
              </div>
            )}
            {stakingPct > 0 && (
              <div className="flex justify-between text-type-xs">
                <span className="text-signal-green">
                  {stakingTier ?? "Staking"} staking -{stakingPct}%
                </span>
                <span className="text-signal-green font-bold tabular-nums">
                  -${stakingDiscountAmount.toFixed(2)}
                </span>
              </div>
            )}
            <Separator className="my-2" />
            <div className="flex justify-between">
              <Label>Total</Label>
              <div className="text-right">
                {stakingPct > 0 && (
                  <span className="block text-type-2xs text-text-dim line-through tabular-nums">
                    ${price.toFixed(2)}
                  </span>
                )}
                <span className="text-type-xl font-bold text-cdx-electric tabular-nums">
                  ${previewTotal.toFixed(2)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Staking Discount CTA — hide entirely once maxed; nudge toward next tier otherwise. */}
        {stakingDiscount?.nextTier && (
          <Link
            href="/docs/token/staking"
            className="flex items-center gap-2 px-3 py-2 border border-signal-green/30 bg-signal-green/5 hover:bg-signal-green/10 transition-colors group"
          >
            <Gift className="h-3.5 w-3.5 text-signal-green shrink-0" />
            <span className="text-type-2xs text-text-secondary leading-relaxed">
              {stakingPct > 0 ? (
                <>
                  Stake to{" "}
                  <span className="text-signal-green font-bold">
                    {stakingDiscount.nextTier.name}
                  </span>{" "}
                  for{" "}
                  <span className="text-signal-green font-bold">
                    {stakingDiscount.nextTier.discount}% off
                  </span>{" "}
                  credit purchases
                </>
              ) : (
                <>
                  Stake CDX for up to{" "}
                  <span className="text-signal-green font-bold">30% off</span> all
                  credit purchases
                </>
              )}
            </span>
            <span className="ml-auto text-type-2xs text-cdx-electric group-hover:underline shrink-0">
              Learn more →
            </span>
          </Link>
        )}

        {/* X402 Info */}
        {paymentProvider === "x402" && (
          <Alert variant="info" className="py-2" scanLines={false}>
            <AlertDescription className="flex items-start gap-2">
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span className="text-type-2xs leading-relaxed">
                Pay with USDC on Base network. Gasless transaction using
                EIP-3009 — no ETH needed for gas.
              </span>
            </AlertDescription>
          </Alert>
        )}

        {/* Purchase Button */}
        <Button
          onClick={handlePurchase}
          disabled={purchaseCreditsMutation.isPending || isConnecting}
          className={cn(
            "w-full",
            paymentProvider === "x402" &&
              "bg-signal-cyan border-signal-cyan text-background hover:bg-signal-cyan/90 shadow-[0_0_20px_rgba(0,255,255,0.3)]"
          )}
        >
          {purchaseCreditsMutation.isPending || isConnecting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin-arc" />
              Processing...
            </>
          ) : paymentProvider === "coinbase" ? (
            <>
              <CreditCard className="w-4 h-4" />
              Purchase Credits
              <ExternalLink className="w-3 h-3 opacity-70" />
            </>
          ) : (
            <>
              <Wallet className="w-4 h-4" />
              {isConnected ? "Pay with USDC" : "Connect Wallet"}
            </>
          )}
        </Button>

        {paymentProvider === "coinbase" && (
          <p className="text-[9px] text-center text-text-secondary uppercase tracking-brand-wide">
            Coinbase Commerce · Crypto & card accepted
          </p>
        )}
      </CardContent>
    </Card>
  );
}
