import { create } from "zustand";
import type { IngestionProposal, DecideProposalRequest, ProposalId } from "@knowself/contracts";
import type { Transport } from "../transport/types";

interface InboxState {
  pending: IngestionProposal[];
  loading: boolean;
  error: string | null;
  /** 拉取所有 pending proposal（「待整理」收件箱）。 */
  load: (t: Transport) => Promise<void>;
  /** 决策一条 proposal，成功后从列表移除。 */
  decide: (id: ProposalId, body: DecideProposalRequest, t: Transport) => Promise<void>;
}

export const useInboxStore = create<InboxState>((set, get) => ({
  pending: [],
  loading: false,
  error: null,

  load: async (t) => {
    set({ loading: true, error: null });
    try {
      const pending = await t.listProposals({ status: "pending" });
      set({ pending, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  decide: async (id, body, t) => {
    try {
      await t.decideProposal(id, body);
      // 决策后不再 pending，从收件箱移除
      set({ pending: get().pending.filter((p) => p.id !== id) });
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
