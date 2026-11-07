# @knowself/chat-ingest

聊天记录摄入管线（DESIGN-11）。**只读**导出产物，不调用外部工具、不自动发送消息；
所有落档走 `person-store` 的 `commitStaged`，本包不直连数据库。

## 公开入口

```ts
import { ingestExport, createChatMessageCommitter } from "@knowself/chat-ingest";

const result = await ingestExport({
  store: personStore,          // PersonStore（persons.sqlite）
  dir: "/path/to/export",      // 只读导出目录
  reader: "txt" | "json",      // 缺省 "txt"（tarry9110 产物）
  now: new Date().toISOString(),
  batch_id: undefined,         // 复用批次 = 断点续跑
  only: ["张三"],               // 关键字过滤
  tool_version: "unknown",

  // ── 完整管线（DESIGN-11 §6.3）：三者齐备才启用 ──
  source_id: "<uuid>",                                  // proposal.source_id
  proposalSink: myProposalSink,                          // 写 ingestion_proposals + accept
  chatCommitter: createChatMessageCommitter(personStore), // 落档提交器
  tierConfig: { auto_ok: [...], review: [...] },          // 由调用方读文件后传入
});
```

返回值（`IngestExportResult`）：`batch_id` / `conversation_count` / `message_count` /
`committed` / `skipped` / `issues`，以及 `mode`（`pipeline` | `legacy`）、`tier`（auto/review 会话数）、
`proposals`（created/accepted/queued/reused/skipped_messages）、`cursor_filtered`。

### 两种模式

| 模式 | 触发条件 | 行为 |
| --- | --- | --- |
| `pipeline` | 注入 `proposalSink` + `chatCommitter` + `source_id` | reader → normalize → staging → **Tier 判定** → **游标过滤** → **proposal** → Tier A 自动 accept / Tier B 入队 |
| `legacy` | 三者未注入（既有单测 / `scripts/verify-real.ts`） | reader → normalize → staging → 直接 `commitStaged`；不产 proposal、不判 Tier、不预筛游标 |

> Tier A **也必须**经 `proposal → accept → committer`（DESIGN-11 §6.3），不存在「规则直接 INSERT」的捷径。
> 只注入其中一项会抛 `INVALID_TARGET_REF`，不静默降级。

## 依赖注入位

| 注入位 | 类型 | 谁来装配 |
| --- | --- | --- |
| `store` | `PersonStore`（结构化使用：`staging` / `commitStaged` / `conversations` / `aliases` / `messages`） | apps/server |
| `proposalSink` | `IngestProposalSink`：`listPending` / `create` / `accept` | apps/server（写 `ingestion_proposals` + 调 `ingestion.acceptProposal`） |
| `chatCommitter` | `ChatMessageCommitter` 结构等价接口 | `createChatMessageCommitter(personStore)` |
| `tierConfig` | `{ auto_ok?: string[]; review?: string[] }` | 调用方读 `data/chat-ingest/*.txt` 后传入（领域函数不碰文件） |

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | `ingestExport` 编排（pipeline / legacy 双模式） |
| `src/reader.ts` | txt reader（探测 / 解码 / 头部 / 行缓冲） |
| `src/normalize.ts` + `src/lines.ts` + `src/time.ts` | 行状态机 → `NormalizedMessage` |
| `src/descriptor.ts` + `src/descriptors/*.json` | 格式知识（数据文件），换工具零改动 |
| `src/readers/json.ts` | JSON reader（字段映射亦在 descriptor） |
| `src/tier.ts` | Tier 判定：11 个 `reason_code` + Tier A 四条硬门槛（纯规则，无 LLM） |
| `src/cursor.ts` | §5.2 过滤 + §5.3 L3 单调游标（纯函数 + 薄 store） |
| `src/proposal.ts` | proposal 分片（≤2000/片）、§6.3 审计字段、§6.5 去重 |
| `src/committer.ts` | `ChatMessageCommitter` 实现（幂等落档） |
| `src/errors.ts` | §8.1 错误码 |

## 已知限制

1. txt 产物无平台消息 ID → `ID_FALLBACK` 恒命中 → P0 的 txt 路径恒为 Tier B（§6.2 规则 6 的直接后果）。
2. `commitStaged` 为会话级落档粒度；proposal 的 2000 条分片只影响审计/队列粒度。
3. §6.5 的「复用既有 pending」不追加 `message_ids`（profile 库无该 API），未覆盖消息留到下一批。
