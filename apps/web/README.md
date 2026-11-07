# @knowself/web

新的独立 Web 前端壳，以 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `apps/web` 为构建与目录规范基础（**B1 裁剪形态**）：Vite + React 18 + TypeScript，`resolve.dedupe` 等配置约定取自 dsh。

**不复用、不依赖迁移前的任何前端代码**：旧 `src/`、`tests/`、`e2e/`、`public/` 与 `dist/` 已整体移除；新壳全部重写。

## 为什么是「裁剪」而不是直接跑 dsh 客户端

dsh 的 `apps/web` 不是独立应用：它的 `vite.config.ts` 带 `rejectStandaloneServe()`，入口 `main.ts` 构造 `AppWebEntry` 并要求 host 注入 `window.__DSH_BOOT__` / transport / session。因此本壳：

- 保留：Vite/React 配置结构、`index.html` 入口约定、`resolve.dedupe`、语义 CSS 令牌与 `ui-*` 组件组织方式
- 移除：`rejectStandaloneServe`、`clientBuildEnvironmentDefines`、`productWebBundleIsolation`、katex 字体插件、`AppWebEntry`、`__DSH_BOOT__`、全部 dsh agent host 依赖
- 仍由 knowSelf 后端（`/api/*`，Vite proxy → `127.0.0.1:9527`）提供数据，不引入 dsh CLI/host

## 运行

```bash
npm run dev:web                       # Vite dev server, http://127.0.0.1:5173
npm --workspace @knowself/web run build
npx vitest run apps/web/tests        # 新前端单测
npx playwright test --config apps/web/playwright.config.ts   # 需先启动 dev:web
```

## 目录

```
src/
  main.tsx                    独立 createRoot 入口
  App.tsx                     路由 / 快捷键 / 主题 / 状态轮询
  routes.ts                   9 条 URL 与页面映射（保持迁移前契约）
  shell/AppShell.tsx          侧栏 + 顶栏 + 内容区
  ui/primitives.tsx           Button/Badge/Card/Spinner/EmptyState/Toast…
  transport/                  重写后的 REST 传输层
  features/inbox/             试点页：待整理（接受 / 编辑 / 拒绝）
  features/placeholder/       其余 8 页的迁移占位
  styles.css                  语义令牌 + 明暗主题
```

本轮交付「骨架 + 试点页」，其余页面逐页迁移中，详见 `docs/units/web-ui/dsh-migration-2026-11-07.md`。
