# dsh 插件工作区

`dsh/knowself/` 是 knowSelf 唯一的 UI/宿主工作区，运行在官方 dsh + Electron Desktop 中。
根 `packages/*` 继续承载领域模型、持久化、检索、导入及 provider/MCP 适配；它们不依赖 dsh UI。

## 常用命令

```bash
npm run dev:dsh
npm run verify:dsh
npm run verify:dsh:desktop
```

插件目录是独立的 pnpm workspace。`knowself-dsh-plugin-0.5.2.tgz` 保留在插件目录，因为
Desktop profile、修复脚本和工件一致性检查仍以它为输入；不要移动或删除该文件。

历史设计、工单和交接资料位于 `docs/archive/dsh-integration/`。当前事实以
`docs/shared/current/` 与 `docs/PROGRESS.md` 为准。
