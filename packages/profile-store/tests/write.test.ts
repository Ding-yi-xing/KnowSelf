import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openProfileDb, type ProfileDb } from "../src/db";
import { createCoreRepo } from "../src/repository/core";
import { createCardsRepo } from "../src/repository/cards";
import { createJournalRepo } from "../src/repository/journal";
import { createEventBus } from "../src/events";
import { dispatchWrite } from "../src/write";
import { AutowriteRejectedError } from "../src/errors";
import type { ProfileChangeEvent } from "@knowself/contracts";

function makeDeps(db: ProfileDb) {
  const events = createEventBus();
  return {
    core: createCoreRepo(db),
    cards: createCardsRepo(db),
    journal: createJournalRepo(db),
    events,
  };
}

describe("dispatchWrite", () => {
  let db: ProfileDb;

  beforeEach(() => {
    db = openProfileDb(":memory:");
  });

  afterEach(() => {
    db.raw.close();
  });

  describe("provenance guard", () => {
    it("allows ui caller with user provenance (core)", () => {
      const deps = makeDeps(db);
      expect(() =>
        dispatchWrite(
          deps,
          {
            target: "core" as const,
            body: "hello",
            provenance: "user" as const,
          },
          { callerKind: "ui" },
        ),
      ).not.toThrow();
    });

    it("rejects ui caller with assistant provenance", () => {
      const deps = makeDeps(db);
      expect(() =>
        dispatchWrite(
          deps,
          {
            target: "core" as const,
            body: "hello",
            provenance: "assistant" as const,
          },
          { callerKind: "ui" },
        ),
      ).toThrow(AutowriteRejectedError);
    });

    it("allows ingestion caller with assistant provenance (journal)", () => {
      const deps = makeDeps(db);
      expect(() =>
        dispatchWrite(
          deps,
          {
            target: "journal" as const,
            date: "2026-05-27",
            body: "entry",
            provenance: "assistant" as const,
            tags: [],
          },
          { callerKind: "ingestion" },
        ),
      ).not.toThrow();
    });

    it("allows ingestion caller with import provenance", () => {
      const deps = makeDeps(db);
      expect(() =>
        dispatchWrite(
          deps,
          {
            target: "journal" as const,
            date: "2026-05-27",
            body: "entry",
            provenance: "import" as const,
            tags: [],
          },
          { callerKind: "ingestion" },
        ),
      ).not.toThrow();
    });

    it("rejects ingestion caller with user provenance", () => {
      const deps = makeDeps(db);
      expect(() =>
        dispatchWrite(
          deps,
          {
            target: "journal" as const,
            date: "2026-05-27",
            body: "entry",
            provenance: "user" as const,
            tags: [],
          },
          { callerKind: "ingestion" },
        ),
      ).toThrow(AutowriteRejectedError);
    });
  });

  describe("event emission", () => {
    it("emits event after core write", () => {
      const deps = makeDeps(db);
      let emitted: ProfileChangeEvent | null = null;
      deps.events.on((e) => {
        emitted = e;
      });

      dispatchWrite(
        deps,
        { target: "core" as const, body: "hello", provenance: "user" as const },
        { callerKind: "ui" },
      );
      expect(emitted).not.toBeNull();
      expect(emitted!.ref_kind).toBe("core");
      expect(emitted!.ref_id).toBe("core_main");
      expect(emitted!.kind).toBe("update");
    });

    it("emits event after card write", () => {
      const deps = makeDeps(db);
      let emitted: ProfileChangeEvent | null = null;
      deps.events.on((e) => {
        emitted = e;
      });

      dispatchWrite(
        deps,
        {
          target: "card" as const,
          key: "work",
          title: "Work",
          summary: "Stuff",
          sections: [],
          provenance: "user" as const,
        },
        { callerKind: "ui" },
      );
      expect(emitted!.ref_kind).toBe("card");
      expect(emitted!.ref_id).toBe("card_work");
    });

    it("emits event after journal append", () => {
      const deps = makeDeps(db);
      let emitted: ProfileChangeEvent | null = null;
      deps.events.on((e) => {
        emitted = e;
      });

      dispatchWrite(
        deps,
        {
          target: "journal" as const,
          date: "2026-05-27",
          body: "entry",
          provenance: "user" as const,
          tags: [],
        },
        { callerKind: "ui" },
      );
      expect(emitted!.ref_kind).toBe("journal_record");
      expect(emitted!.kind).toBe("add");
    });

    it("writes core data through dispatch", () => {
      const deps = makeDeps(db);
      dispatchWrite(
        deps,
        {
          target: "core" as const,
          body: "test body",
          display_name: "Test",
          provenance: "user" as const,
        },
        { callerKind: "ui" },
      );
      const stored = deps.core.get();
      expect(stored.body).toBe("test body");
    });
  });
});
