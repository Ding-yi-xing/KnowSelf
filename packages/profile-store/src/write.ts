import type {
  WriteRequest,
  ProfileChangeEvent,
  CoreProfileInput,
  CardInput,
  AppendCardSection,
  AppendJournal,
} from "@knowself/contracts";
import { AutowriteRejectedError } from "./errors";

export interface WriteDeps {
  core: { save(input: CoreProfileInput, now: string): void };
  cards: {
    save(input: CardInput, now: string): void;
    appendSection(req: AppendCardSection, now: string): void;
  };
  journal: { append(req: AppendJournal, now: string): { id: number } };
  events: { emit(event: ProfileChangeEvent): void };
}

function makeEvent(
  kind: ProfileChangeEvent["kind"],
  refKind: ProfileChangeEvent["ref_kind"],
  refId: string,
  provenance: ProfileChangeEvent["provenance"],
): ProfileChangeEvent {
  return {
    kind,
    ref_kind: refKind,
    ref_id: refId,
    occurred_at: new Date().toISOString(),
    provenance,
  };
}

function guardProvenance(provenance: string, callerKind: "ui" | "ingestion"): void {
  if (callerKind === "ui" && provenance !== "user") {
    throw new AutowriteRejectedError(`UI 调用方 provenance 必须为 "user"，实际为 "${provenance}"`);
  }
  if (callerKind === "ingestion" && provenance !== "assistant" && provenance !== "import") {
    throw new AutowriteRejectedError(
      `ingestion 调用方 provenance 必须为 "assistant" 或 "import"，实际为 "${provenance}"`,
    );
  }
}

export function dispatchWrite(
  deps: WriteDeps,
  req: WriteRequest,
  ctx: { callerKind: "ui" | "ingestion" },
): void {
  guardProvenance(req.provenance, ctx.callerKind);
  const now = new Date().toISOString();
  const prov = req.provenance;

  if (req.target === "core") {
    deps.core.save(req, now);
    deps.events.emit(makeEvent("update", "core", "core_main", prov));
    return;
  }

  if (req.target === "card") {
    deps.cards.save(req, now);
    deps.events.emit(makeEvent("update", "card", `card_${req.key}`, prov));
    return;
  }

  if (req.target === "card_section") {
    deps.cards.appendSection(req, now);
    deps.events.emit(
      makeEvent("add", "card_section", `card_section:${req.key}:${req.section}`, prov),
    );
    return;
  }

  if (req.target === "journal") {
    const record = deps.journal.append(req, now);
    deps.events.emit(makeEvent("add", "journal_record", `journal_record:${record.id}`, prov));
    return;
  }
}
