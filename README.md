# knowSelf

本地优先的"个人画像 + 决策辅助"应用。

- **MVP**：网页版（Vite + React + Hono BFF）
- **V2**：Tauri 2.x 桌面端（保留 Transport 抽象层切换）

## 状态

- 阶段 0 Bootstrap、阶段 1 分析、阶段 2 方案 全部完成
- 阶段 3 执行：刚搭好 monorepo 骨架，业务代码尚未编写

## 文档入口

请按以下顺序阅读：

1. `CLAUDE.md` — 项目角色与协作方式
2. `docs/PROGRESS.md` — 当前进度快照（新对话从这里接续）
3. `docs/.project-docs-manifest.yaml` — 工作单元 manifest
4. `docs/DESIGN.md` — 长期技术栈与架构原则
5. `docs/ARCHITECTURE.md` — 全局分层与数据流
6. `docs/QUALITY.md` — 测试策略与覆盖率底线
7. `docs/units/<unit>/{manifest,status,file-manifest}.md` — 各工作单元详细方案
8. `docs/shared/contracts/*.ts` — 9 份 Zod schema 契约（单一真相源）
9. `docs/shared/decisions/*.md` — 关键决策记录

## 起步

```bash
npm install                    # 安装依赖（阶段 3 编码完成后）
npm run dev                    # 同时起 server (5174) + web (5173)
npm run test                   # 跑全 workspace vitest
npm run e2e                    # 跑 Playwright
npm run ci                     # typecheck + lint + format:check + test + e2e
```

## 工作单元

| Unit             | 路径                        | 职责                                 |
| ---------------- | --------------------------- | ------------------------------------ |
| contracts        | `packages/contracts`        | Zod schema 单一真相源（9 份）        |
| config           | `packages/config`           | settings.json 读写 + 路径解析        |
| profile-store    | `packages/profile-store`    | profile.sqlite 主存 + 三种导出       |
| mcp-host         | `packages/mcp-host`         | 外部 stdio MCP 客户端 + 工具命名空间 |
| provider-adapter | `packages/provider-adapter` | 多 provider 协议适配 + 工具循环      |
| ingestion        | `packages/ingestion`        | 多格式 extractor + 蒸馏 + 审阅落档   |
| context-router   | `packages/context-router`   | L1/L2/L3 注入 + 混合检索 + 重排      |
| chat-engine      | `apps/server`               | Hono BFF + API 路由 + SSE            |
| web-ui           | `apps/web`                  | Vite + React + Zustand + shadcn/ui   |

## 配置

复制 `settings.example.json` 为 `settings.json`，把 `api_key` 替换为真实 key。
`settings.json` 与 `data/` 都不进 git。

## 阶段 3 编码顺序

按依赖叶子到根：

1. `packages/contracts` — 把 `docs/shared/contracts/*.ts` 抄录加 export
2. `packages/config`
3. `packages/profile-store`
4. `packages/mcp-host` 与 `packages/provider-adapter`（可并行）
5. `packages/ingestion`
6. `packages/context-router`
7. `apps/server`
8. `apps/web`

每个文件实现完跑该文件对应的 vitest，绿了再下一个。
