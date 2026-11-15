# knowSelf

本地优先的个人画像与决策辅助应用。

**唯一产品运行时：官方 dsh + Electron Desktop。**

- 插件与面板：`dsh/knowself/`
- 领域能力与持久化：`packages/*`
- 用户运行时数据：`data/`（不纳入 Git）
- 运行配置：`settings.json`（不纳入 Git）
- 当前架构事实源：`docs/shared/current/当前运行时拓扑与入口决策.md`

旧 `apps/web`、`apps/server` 与 Tauri 源码已于 2026-11-15 删除；历史文档位于
`docs/archive/legacy-web-tauri/`，仅供追溯。

## 文档入口

1. `CLAUDE.md` — 项目角色与协作方式
2. `docs/PROGRESS.md` — 当前进度快照
3. `docs/.project-docs-manifest.yaml` — 工作单元入口
4. `docs/shared/current/当前阶段目标与范围.md` — 当前阶段范围
5. `docs/shared/current/当前运行时拓扑与入口决策.md` — 当前运行时事实
6. `docs/units/desktop/manifest.md` — Desktop / dsh 交付入口

## 启动与验证

```bash
pnpm --dir dsh/knowself install # 首次安装 dsh 插件依赖
npm run dev                     # 启动 dsh / Electron Desktop
npm run verify:dsh              # dsh typecheck + 测试 + bundle + package
npm run verify:dsh:desktop      # 已配置 Desktop 环境时追加升级门禁
```

## 工作单元

| Unit | 路径 | 职责 |
| --- | --- | --- |
| contracts | `packages/contracts` | Zod schema 单一真相源 |
| config | `packages/config` | settings.json 读写 + 路径解析 |
| profile-store | `packages/profile-store` | profile.sqlite 主存 + 导出 |
| person-store | `packages/person-store` | 多主体档案与加密聊天索引 |
| chat-ingest | `packages/chat-ingest` | 聊天记录导入与提案转换 |
| mining | `packages/mining` | 消息挖掘与蒸馏 |
| mcp-host | `packages/mcp-host` | 外部 stdio MCP 客户端 + 工具命名空间 |
| provider-adapter | `packages/provider-adapter` | 多 provider 协议适配 + 工具循环 |
| ingestion | `packages/ingestion` | 多格式 extractor + 蒸馏 + 审阅落档 |
| context-router | `packages/context-router` | L1/L2/L3 注入 + 混合检索 + 重排 |
| sync-provider | `packages/sync-provider` | 多设备同步抽象 |
| dsh-plugin | `dsh/knowself` | dsh 宿主适配、工具、面板与交互编排 |

复制 `settings.example.json` 为 `settings.json`，把 `api_key` 替换为真实 key。
