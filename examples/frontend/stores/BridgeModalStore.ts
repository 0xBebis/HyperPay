import { create } from "zustand";

type ToolModal = "hl-bridge" | "cctp-bridge" | "swap" | null;

interface ToolModalState {
  activeModal: ToolModal;
  openHlBridge: () => void;
  openCctpBridge: () => void;
  openSwap: () => void;
  close: () => void;
}

export const useBridgeModalStore = create<ToolModalState>((set) => ({
  activeModal: null,
  openHlBridge: () => set({ activeModal: "hl-bridge" }),
  openCctpBridge: () => set({ activeModal: "cctp-bridge" }),
  openSwap: () => set({ activeModal: "swap" }),
  close: () => set({ activeModal: null }),
}));
