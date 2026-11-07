import { openProfileDb } from "./db";
import { createCoreRepo } from "./repository/core";
import { createCardsRepo } from "./repository/cards";
import { createJournalRepo } from "./repository/journal";
import { createSourcesRepo } from "./repository/sources";
import { createProposalsRepo } from "./repository/proposals";
import { createLinksRepo } from "./repository/links";
import { createTemplatesRepo } from "./repository/templates";
import { createEventBus } from "./events";
import { dispatchWrite } from "./write";
import { exportProfile, exportProfileBuffer } from "./export";
import type { WriteRequest, ExportRequest, ExportResponse } from "@knowself/contracts";

export interface ProfileStore {
  core: ReturnType<typeof createCoreRepo>;
  cards: ReturnType<typeof createCardsRepo>;
  journal: ReturnType<typeof createJournalRepo>;
  sources: ReturnType<typeof createSourcesRepo>;
  proposals: ReturnType<typeof createProposalsRepo>;
  links: ReturnType<typeof createLinksRepo>;
  templates: ReturnType<typeof createTemplatesRepo>;
  events: ReturnType<typeof createEventBus>;
  write(req: WriteRequest, ctx: { callerKind: "ui" | "ingestion" }): void;
  transaction<T>(fn: () => T): T;
  exportProfile(req: ExportRequest): Promise<ExportResponse>;
  exportProfileBuffer(): Promise<Buffer>;
  close(): void;
}

export function createProfileStore(opts: {
  dbPath: string;
  sourcesDir: string;
  exportsDir: string;
}): ProfileStore {
  const db = openProfileDb(opts.dbPath);
  const core = createCoreRepo(db);
  const cards = createCardsRepo(db);
  const journal = createJournalRepo(db);
  const sources = createSourcesRepo(db);
  const proposals = createProposalsRepo(db);
  const links = createLinksRepo(db);
  const templates = createTemplatesRepo(db);
  const events = createEventBus();

  return {
    core,
    cards,
    journal,
    sources,
    proposals,
    links,
    templates,
    events,
    write(req: WriteRequest, ctx: { callerKind: "ui" | "ingestion" }): void {
      dispatchWrite(
        { core, cards, journal, events } as Parameters<typeof dispatchWrite>[0],
        req,
        ctx,
      );
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
    exportProfile(req: ExportRequest): Promise<ExportResponse> {
      return exportProfile({ db, sourcesDir: opts.sourcesDir, exportsDir: opts.exportsDir }, req);
    },
    exportProfileBuffer(): Promise<Buffer> {
      return exportProfileBuffer({ db, sourcesDir: opts.sourcesDir });
    },
    close(): void {
      db.raw.close();
    },
  };
}
