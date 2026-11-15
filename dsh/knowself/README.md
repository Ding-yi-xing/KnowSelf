# knowSelf dsh 插件

这是 knowSelf 唯一的 UI 与宿主适配包，运行于官方 dsh + Electron Desktop。领域逻辑和持久化由根 `packages/*` 提供。

## 命令

```bash
pnpm typecheck
pnpm test
pnpm run build:dsh
pnpm run build:package
```

根目录提供组合门禁：`npm run verify:dsh`、`npm run verify:dsh:desktop`。

本目录使用独立 pnpm workspace，通过 `file:../../packages/*` 引用领域包。不要将 dsh/Electron 依赖引入根领域包。

`knowself-dsh-plugin-0.5.2.tgz` 是当前 Desktop profile、修复脚本及工件一致性检查的输入，必须留在本目录。

历史工单、旧 README 和交接资料位于 `docs/archive/dsh-integration/`；当前事实以 `docs/PROGRESS.md` 与 `docs/shared/current/` 为准。
