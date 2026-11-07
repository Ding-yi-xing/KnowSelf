import { create } from "zustand";
import type {
  SourceId,
  SourceStored,
  SourceDetail,
  ProposalId,
  DecideProposalRequest,
} from "@knowself/contracts";
import type { Transport, SourceCreateInput } from "../transport/types";

interface SourcesState {
  sources: SourceStored[];
  current: SourceDetail | null;
  loading: boolean;
  error: string | null;
  uploadProgress: number | null;
  load: (t: Transport) => Promise<void>;
  create: (body: SourceCreateInput, t: Transport) => Promise<SourceStored>;
  get: (id: SourceId, t: Transport) => Promise<void>;
  remove: (id: SourceId, t: Transport) => Promise<void>;
  removeMany: (ids: SourceId[], t: Transport) => Promise<void>;
  runIngest: (id: SourceId, t: Transport) => Promise<void>;
  decideProposal: (id: ProposalId, body: DecideProposalRequest, t: Transport) => Promise<void>;
}

export const useSourcesStore = create<SourcesState>((set, get) => ({
  sources: [],
  current: null,
  loading: false,
  error: null,
  uploadProgress: null,

  load: async (t) => {
    set({ loading: true, error: null });
    try {
      const sources = await t.listSources();
      set({ sources, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  create: async (body, t) => {
    set({ loading: true, error: null, uploadProgress: 0 });
    try {
      const stored = await t.createSource(body, (pct) => set({ uploadProgress: pct }));
      const sources = [stored, ...get().sources];
      set({ sources, loading: false, uploadProgress: null });
      return stored;
    } catch (err) {
      set({ error: (err as Error).message, loading: false, uploadProgress: null });
      throw err;
    }
  },

  get: async (id, t) => {
    set({ loading: true, error: null });
    try {
      const current = await t.getSource(id);
      set({ current, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  remove: async (id, t) => {
    set({ loading: true, error: null });
    try {
      await t.deleteSource(id);
      const sources = get().sources.filter((s) => s.id !== id);
      const current = get().current?.source.id === id ? null : get().current;
      set({ sources, current, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  removeMany: async (ids, t) => {
    if (ids.length === 0) return;
    set({ loading: true, error: null });
    try {
      await t.deleteSources(ids);
      const idSet = new Set(ids);
      const sources = get().sources.filter((s) => !idSet.has(s.id));
      const cur = get().current;
      const current = cur && idSet.has(cur.source.id) ? null : cur;
      set({ sources, current, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  runIngest: async (id, t) => {
    set({ loading: true, error: null });
    try {
      await t.runIngest(id);
      const current = await t.getSource(id);
      set({ current, loading: false });
      const sources = get().sources.map((s) => (s.id === id ? current.source : s));
      set({ sources });
      return;
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
      throw err;
    }
  },

  decideProposal: async (id, body, t) => {
    try {
      const updated = await t.decideProposal(id, body);
      const current = get().current;
      if (current) {
        const proposals = current.proposals.map((p) => (p.id === id ? updated : p));
        set({ current: { ...current, proposals } });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },
}));
