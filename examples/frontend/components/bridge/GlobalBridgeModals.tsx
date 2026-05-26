"use client";

import dynamic from "next/dynamic";
import { ArrowLeftRight, ArrowRightLeft, Layers } from "lucide-react";
import { useBridgeModalStore } from "@/stores/useBridgeModalStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const HyperliquidBridge = dynamic(
  () => import("@/components/wallet/operations/HyperliquidBridge")
);

const CctpBridge = dynamic(
  () => import("@/components/wallet/operations/CctpBridge")
);

const Swap = dynamic(
  () => import("@/components/wallet/operations/Swap").then((m) => ({ default: m.Swap }))
);

export function GlobalBridgeModals() {
  const { activeModal, close } = useBridgeModalStore();

  return (
    <>
      {/* Token Swap Modal */}
      <Dialog open={activeModal === "swap"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-2xl lg:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="w-5 h-5" />
              Token Swap
            </DialogTitle>
            <DialogDescription>
              Swap tokens instantly via DEX aggregation
            </DialogDescription>
          </DialogHeader>
          <Swap />
        </DialogContent>
      </Dialog>

      {/* Hyperliquid Bridge Modal */}
      <Dialog open={activeModal === "hl-bridge"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-2xl lg:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Layers className="w-5 h-5" />
              Hyperliquid Bridge
            </DialogTitle>
            <DialogDescription>
              Bridge USDC between Arbitrum and Hyperliquid
            </DialogDescription>
          </DialogHeader>
          <HyperliquidBridge agentWallet="" onTransferComplete={close} />
        </DialogContent>
      </Dialog>

      {/* CCTP Cross-Chain Bridge Modal */}
      <Dialog open={activeModal === "cctp-bridge"} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-2xl lg:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="w-5 h-5" />
              CCTP Bridge
            </DialogTitle>
            <DialogDescription>
              Bridge USDC across chains via Circle CCTP
            </DialogDescription>
          </DialogHeader>
          <CctpBridge onTransferComplete={close} />
        </DialogContent>
      </Dialog>
    </>
  );
}
