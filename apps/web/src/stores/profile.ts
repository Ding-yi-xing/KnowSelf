import { create } from "zustand";
import type {
  CoreProfileStored,
  CoreProfileInput,
  CardSummary,
  CardKey,
  CardStored,
  CardInput,
  JournalDate,
  JournalDateSummary,
  JournalEntryStored,
} from "@knowself/contracts";
import type { TransportError } from "../transport/types";
import type { useTransport } from "./transport-context";

interface CardEntry {
  summary: CardSummary;
  full?: CardStored;
  dirty: boolean;
}

interface JournalEntry {
  summary: JournalDateSummary;
  full?: JournalEntryStored;
}

interface ProfileState {
  core: CoreProfileStored | null;
  cards: Map<string, CardEntry>;
  journals: Map<string, JournalEntry>;
  loading: boolean;
  error: TransportError | null;

  loadCore: (t: ReturnType<typeof useTransport>) => Promise<void>;
  saveCore: (input: CoreProfileInput, t: ReturnType<typeof useTransport>) => Promise<void>;
  loadCardList: (t: ReturnType<typeof useTransport>) => Promise<void>;
  loadCard: (key: CardKey, t: ReturnType<typeof useTransport>) => Promise<void>;
  saveCard: (
    key: CardKey,
    input: Omit<CardInput, "key">,
    t: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  appendSection: (
    key: CardKey,
    section: string,
    body: string,
    t: ReturnType<typeof useTransport>,
  ) => Promise<void>;
  loadJournalList: (t: ReturnType<typeof useTransport>) => Promise<void>;
  loadJournal: (date: JournalDate, t: ReturnType<typeof useTransport>) => Promise<void>;
  appendJournal: (
    date: JournalDate,
    body: string,
    tags: string[] | undefined,
    t: ReturnType<typeof useTransport>,
  ) => Promise<void>;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  core: null,
  cards: new Map(),
  journals: new Map(),
  loading: false,
  error: null,

  loadCore: async (t) => {
    set({ loading: true, error: null });
    try {
      const core = await t.getCore();
      set({ core, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  saveCore: async (input, t) => {
    set({ loading: true, error: null });
    try {
      await t.saveCore(input);
      const core = await t.getCore();
      set({ core, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  loadCardList: async (t) => {
    set({ loading: true, error: null });
    try {
      const summaries = await t.listCards();
      const cards = new Map<string, CardEntry>();
      for (const s of summaries) {
        cards.set(s.key, { summary: s, dirty: false });
      }
      set({ cards, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  loadCard: async (key, t) => {
    set({ loading: true, error: null });
    try {
      const full = await t.getCard(key);
      const updated = new Map(get().cards);
      const entry = updated.get(key);
      updated.set(key, {
        summary: entry?.summary ?? {
          key: full.key,
          title: full.title,
          summary: full.summary,
          section_tags: full.section_tags,
          updated_at: full.updated_at,
        },
        full,
        dirty: false,
      });
      set({ cards: updated, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  saveCard: async (key, input, t) => {
    set({ loading: true, error: null });
    try {
      await t.saveCard(key, input);
      await get().loadCard(key, t);
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  appendSection: async (key, section, body, t) => {
    set({ loading: true, error: null });
    try {
      await t.appendCardSection(key, { section, body });
      await get().loadCard(key, t);
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  loadJournalList: async (t) => {
    set({ loading: true, error: null });
    try {
      const dates = await t.listJournalDates();
      const journals = new Map<string, JournalEntry>();
      for (const d of dates) {
        journals.set(d.date, { summary: d });
      }
      set({ journals, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  loadJournal: async (date, t) => {
    set({ loading: true, error: null });
    try {
      const full = await t.getJournal(date);
      const updated = new Map(get().journals);
      const prev = updated.get(date);
      updated.set(date, {
        summary: {
          date: full.date,
          record_count: full.records.length,
          updated_at: prev?.summary?.updated_at ?? new Date().toISOString(),
        },
        full,
      });
      set({ journals: updated, loading: false });
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },

  appendJournal: async (date, body, tags, t) => {
    set({ loading: true, error: null });
    try {
      const payload = tags !== undefined ? { body, tags } : { body };
      await t.appendJournal(date, payload);
      await get().loadJournal(date, t);
    } catch (err) {
      set({ error: err as TransportError, loading: false });
    }
  },
}));
