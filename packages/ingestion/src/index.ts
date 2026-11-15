/**
 * @knowself/ingestion — 多格式 extractor + 蒸馏小模型 + IngestionProposal 审阅落档
 *
 * 公开 API：createIngestion(opts) → Ingestion
 */

import type {
  CreateSourceRequest,
  SourceStored,
  SourceId,
  ProposalId,
  IngestionProposal,
  IngestRequest,
  IngestResponse,
  ChatMessageCommitter,
  ChatMessageRejecter,
} from "@knowself/contracts";
import type { ProfileStore } from "@knowself/profile-store";
import type { ProviderAdapter } from "@knowself/provider-adapter";
import type { ToolRegistry } from "@knowself/mcp-host";
import { createSource } from "./intake";
import { runDistill } from "./distill";
import {
  acceptProposal,
  editProposal,
  rejectProposal,
  acceptSourceDistillProposal,
  listProposals,
  listProposalsByStatus,
  type ProposalDeps,
} from "./proposals";
import { scheduleAutoDistill } from "./auto";

export interface IngestionDeps {
  store: ProfileStore;
  providerAdapter: ProviderAdapter;
  toolRegistry: ToolRegistry;
  sourcesDir: string;
  distillProviderId: string;
  conversationId?: string;
  now?: () => string;
  /**
   * 加法式（DESIGN-11 §7.2 #5）：`chat_message` proposal 的落档提交器。
   * 由 `apps/server` 装配时注入（`createChatMessageCommitter({ personStore })`）；
   * 缺省时 `acceptProposal` 的 `chat_message` 分支抛 `INVALID_TARGET_REF`。
   */
  chatCommitter?: ChatMessageCommitter;
  /**
   * 批 1.5：`chat_message` proposal 的拒绝器，与 `chatCommitter` 对称。
   * 由 `apps/server` 装配时注入（`createChatMessageRejecter(personStore)`）；
   * 缺省时 `rejectProposal` 的 `chat_message` 分支抛 `INVALID_TARGET_REF`（不静默成功）。
   */
  chatRejecter?: ChatMessageRejecter;
}

export interface Ingestion {
  createSource(req: CreateSourceRequest, fileBytes?: Buffer): Promise<SourceStored>;

  runDistill(source: SourceStored, req: IngestRequest): Promise<IngestResponse>;

  acceptProposal(proposalId: ProposalId): IngestionProposal;

  /** Accepts a source-distill review request and runs distillation. */
  acceptSourceDistillProposal(proposalId: ProposalId): Promise<IngestionProposal>;

  editProposal(proposalId: ProposalId, body: string): IngestionProposal;

  rejectProposal(proposalId: ProposalId): IngestionProposal;

  listProposals(sourceId: SourceId): IngestionProposal[];

  /** 跨 source 全局列出 proposals（用于「待整理」收件箱）。 */
  listProposalsByStatus(
    status?: IngestionProposal["status"] | "all",
    limit?: number,
  ): IngestionProposal[];

  scheduleAutoDistill(
    conversationId: string,
    messages: Parameters<typeof scheduleAutoDistill>[2],
  ): void;
}

export function createIngestion(deps: IngestionDeps): Ingestion {
  const convId = deps.conversationId ?? "00000000-0000-0000-0000-000000000000";
  const now = deps.now ?? (() => new Date().toISOString());

  const intakeDeps = {
    store: deps.store,
    toolRegistry: deps.toolRegistry,
    sourcesDir: deps.sourcesDir,
    conversationId: convId,
    now,
  };

  const distillDeps = {
    store: deps.store,
    providerAdapter: deps.providerAdapter,
    distillProviderId: deps.distillProviderId,
    now,
  };

  const proposalDeps: ProposalDeps = {
    store: deps.store,
    now,
    ...(deps.chatCommitter !== undefined ? { chatCommitter: deps.chatCommitter } : {}),
    ...(deps.chatRejecter !== undefined ? { chatRejecter: deps.chatRejecter } : {}),
  };

  return {
    createSource(req, fileBytes) {
      return createSource(intakeDeps, req, fileBytes);
    },

    runDistill(source, req) {
      return runDistill(distillDeps, source, req);
    },

    acceptProposal(id) {
      return acceptProposal(proposalDeps, id);
    },

    acceptSourceDistillProposal(id) {
      return acceptSourceDistillProposal({ ...proposalDeps, ...distillDeps }, id);
    },

    editProposal(id, body) {
      return editProposal(proposalDeps, id, body);
    },

    rejectProposal(id) {
      return rejectProposal(proposalDeps, id);
    },

    listProposals(sourceId) {
      return listProposals(proposalDeps, sourceId);
    },

    listProposalsByStatus(status, limit) {
      return listProposalsByStatus(proposalDeps, status, limit);
    },

    scheduleAutoDistill(conversationId, messages) {
      scheduleAutoDistill(
        {
          store: deps.store,
          providerAdapter: deps.providerAdapter,
          distillProviderId: deps.distillProviderId,
          createSourceFromMessages: async (convId, msgs) => {
            // 把对话转成 paste source：拼接 user/assistant 文本块
            const text = msgs
              .filter((m) => m.role === "user")
              .map((m) => {
                const bodyText = m.content
                  .filter((b) => b.kind === "text")
                  .map((b) => (b as { text: string }).text)
                  .join("\n");
                return bodyText;
              })
              .join("\n\n")
              .trim();
            if (!text) return { sourceId: "" };
            const src = await createSource(intakeDeps, {
              kind: "paste",
              text,
              original_name: `对话 ${convId.slice(0, 8)} · ${now().slice(0, 10)}`,
              user_note: "",
              user_tags: ["对话蒸馏"],
            });
            return { sourceId: src.id };
          },
          now,
        },
        conversationId,
        messages,
      );
    },
  };
}

// 异常类
export {
  IngestionError,
  SourceNotFoundError,
  ProposalNotFoundError,
  UnsupportedMimeError,
  ExtractorFailedError,
  UrlFetchFailedError,
  FileTooLargeError,
  ProposalNotPendingError,
  DistillFailedError,
  InvalidTargetRefError,
} from "./errors";

// MIME 工具
export { inferMime, isSupportedMime } from "./mime";

// 核心资料入口
export { createSourceIntake } from "./intake";
export type { SourceIntake, SourceIntakeDeps } from "./intake";

// extractors
export { pickExtractor, listExtractors } from "./extractors/index";
export type { IExtractor, ExtractorContext } from "./extractors/types";

// 蒸馏
export { DistillOutputSchema, buildDistillPrompt, writeToProposalTarget } from "./distill-prompt";
