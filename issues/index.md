# knowSelf — 问题清单

> 顶层跨单元问题清单。各工作单元问题清单见 `docs/units/<unit>/status.md` 及 `docs/units/testing/issues/index.md`。
>
> 发现日期：2026-05-30（浏览器黑盒测试 §12）

---

## §13 浏览器全功能回归测试（2026-05-30 第二轮，真实 server + provider）

> **第三轮回环复测（2026-05-30，重启 server + 真实 provider + Playwright）结论**：
> - ✅ **BUG-13-1 已修复**：发"我叫王小明…"后，库中 assistant 正文完整（"你好，小明！…"），刷新后 UI 助手回复仍在。
> - ✅ **BUG-13-3 已修复**：新对话中文标题/正文无乱码（旧脏数据不影响）。
> - ❌ **BUG-13-2 仍未修复**，且根因已深挖到底（见下方更新）。

测试方式：启动真实 server(9527) + web(5173) + 真实 provider(xm/sensenova 均 healthy)，Playwright 逐功能实测，并比对 SQLite 落库内容。

### 结果总览

| 功能 | 预期 | 实测 | 结论 |
|---|---|---|---|
| 应用加载 / 导航 | 9 项导航含「待整理」，正常渲染 | ✅ | 通过 |
| 发消息 → 流式回复 | 助手实时回复显示 | ✅ | 通过 |
| 对话完成提示 | 出现"已提取画像建议/去待整理" | ✅ | 通过 |
| **助手回复持久化** | 刷新后助手回复仍在 | ✅ 已修复（第三轮复测） | 通过 |
| **「待整理」收件箱** | 对话后出现 pending 建议 | ❌ **仍空**（根因见下） | 🔴 BUG-13-2 未修复 |
| 核心档案 | 显示名 + 正文可读 | ✅ | 通过 |
| 模板：内置展示 | 3 个内置模板 | ✅ | 通过 |
| 模板：新建自定义 | 保存成功(此前报 422) | ✅ POST 201 | 已修复 |
| 历史会话乱码 | 中文标题正常 | ✅ 新对话正常 | 已修复 |

### 🔴 BUG-13-1：助手回复不持久化（刷新后只剩用户消息）

**严重度**：🔴 高　**状态**：✅ **已修复并复测通过（2026-05-30 第三轮）**

修复：`runAskToStream` 已返回 `getAssistantText()`（ask.ts:118-139 包装生成器累积 text_delta），`chat.ts:73-91` 用真实文本持久化（空则跳过）。复测：assistant 正文完整入库，刷新后 UI 保留。

### 🔴 BUG-13-2：「待整理」收件箱始终为空

**严重度**：🔴 高　**状态**：⬜ **第二次修复未生效 — 撞上数据库 schema 漂移（2026-05-30 第四轮复测）**

**第四轮复测铁证**：
- 发"我是李雷…"自我介绍消息后，proposals 轮询 90s 仍为 0。
- server 日志出现致命错误：`[auto-distill] unexpected error: table sources has no column named last_error`
- 新对话的 paste source **根本没建出来**（sources 列表里最新仍是旧的"王小明"），即 `createSource` 的 INSERT 因列不匹配整条失败。
- 实测 `PRAGMA table_info(sources)` 于运行中的 `data/profile.sqlite`（**5/27 创建的旧库**）：列为 `…last_ingested_at`，**无 `last_error`**。

**真根因（schema 漂移，非逻辑错）**：第二次修复本身代码是对的——`ddl.ts:75` 已加 `last_error` 列、`repository/sources.ts` 的 `insert`/`updateError`/row 映射都正确引用了它。**但运行中的 `profile.sqlite` 是旧库**，`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列，于是：
1. `sources` INSERT 语句带 `last_error` 列 → 旧表无此列 → 写入抛错 → 新 source 建不出来；
2. `updateError` 的 UPDATE 同样因列缺失抛错；
3. 错误冒泡到 `auto.ts` 外层 catch（日志里的 `unexpected error`），proposal 永远产不出。

**解决方案（二选一，推荐 A）**：
- **A（迁移，推荐）**：在 `packages/profile-store` 打开 DB 后执行轻量迁移——检测 `sources` 表缺 `last_error` 列时 `ALTER TABLE sources ADD COLUMN last_error TEXT`。这样旧库平滑升级，不丢用户数据。建议建立通用 migration 机制（对照 PRAGMA table_info 补齐缺列），避免后续再次漂移。
- **B（仅开发期，丢数据）**：删除 `data/profile.sqlite` 让其按新 DDL 重建。**会丢失已有档案/资料/proposal**，仅在确认旧库无价值时用。

> ⚠️ 注意：`conversations.sqlite`、`retrieval.sqlite` 若也有过 DDL 加列，同样可能漂移，一并检查。

**附带确认**：structured.ts 的 30s 超时 + `extractJsonBlock`（剥离代码围栏/提取 `{...}`）已正确实现；sources ingest 路由的 404/502 区分也到位。这两项无需再改——本轮卡在更前面的建 source 阶段，蒸馏 LLM 调用还没机会跑。

### 🟠 BUG-13-3：历史会话中文 lone-surrogate 乱码

**严重度**：🟠 中　**状态**：✅ **已修复/不复现（2026-05-30 第三轮）**

第三轮重启 server 后发多条中文消息（"我叫王小明…"等），标题/正文全部正常，无 lone-surrogate。判定为更早旧实例脏数据，当前代码路径不复现。旧脏会话可由用户手动删除，无需改代码。

---

## §12-PROVIDER: anthropic 协议聚合平台鉴权头不匹配 + provider 配置问题

**发现于**: §12.1.1 发起对话（2026-05-30）
**分类**: 真 bug（代码） + 配置问题
**严重度**: 🔴 高
**涉及范围**: §12.1.1~12.1.17（17 个子节全阻塞）
**状态**: ✅ 代码已修复（2026-05-30）；配置项需用户核对

### 现象

- Provider "xxx"（xm）：发送消息 → `PROVIDER_FAIL / HTTP 401`
- Provider "sensenova"（商汤）：发送消息 → `PROVIDER_FAIL / HTTP 404`
- 系统页两个 provider 均 `state=healthy` 但 `last_error` 为 HTTP 401 / 404
- 侧栏状态指示器降为"降级"或"异常"

### 根因（2026-05-30 实测修正）

**早先归因为"api_key 过期"是错的——key 完全有效。** 实测分两类问题：

1. **sensenova（真 bug）**：`adapter/anthropic.ts` 只发 Anthropic 官方鉴权头 `x-api-key`。商汤 `token.sensenova.cn` 虽暴露 anthropic 协议 `/v1/messages` 端点，但鉴权沿用 OpenAI 风格 `Authorization: Bearer`。curl 实测：
   - `/v1/messages` + `x-api-key` → 401 `{"code":16,"message":"Authorization Not Found"}`（不是 key 无效，是头名不对）
   - `/v1/messages` + `Authorization: Bearer` → **200 正常返回**
   - 另外早期 `base_url` 配的是 `https://token.sensenova.cn`（缺 `/v1`），拼成 `/messages` → 404；现已修为 `…/v1`。

2. **xm（配置问题）**：小米 `token-plan-cn.xiaomimimo.com` 聚合平台**只暴露 OpenAI 端点**。实测 `/v1/chat/completions` 返回 401（路由存在），但 `/v1/messages`、`/messages` 全 404。该条 provider `protocol` 配成了 `anthropic`，平台根本不支持——应改为 `openai`（与 id=`xxx` 同平台同 key），或删除。

### 修复方案

**步骤 1（代码，已完成）**：`adapter/anthropic.ts` 同时发 `x-api-key` + `Authorization: Bearer`，官方与聚合平台都兼容。见 provider-adapter `status.md` BUG-PA-01。

**步骤 2（配置，需用户核对）**：
- sensenova：`base_url` 确认为 `https://token.sensenova.cn/v1`（已改）。
- xm：将 `protocol` 从 `anthropic` 改为 `openai`，或删除该重复 provider。

**步骤 3（可选增强 — UI 反馈改善）**：
当前系统健康探测只检查 base_url 可达性，且 ping 走的也是同一个（可能错误的）路由，不验证真实端点 + 鉴权，所以显示 `healthy` 但实际调用 401/404。可在健康检查中加入真实端点轻量探测，让用户一眼看到 provider 是否真的可用。改 `apps/server/src/routes/system.ts`，不在本次范围。

### 受影响测试清单

以下 §12 子节因无有效 AI 响应而无法执行：

- §12.1.1 步骤 4-7（流式回复）
- §12.1.2（流式事件序列）
- §12.1.3（中断对话）
- §12.1.4（多轮对话上下文）
- §12.1.5（工具调用开关）
- §12.1.6（fetch 工具）
- §12.1.7（chrome-devtools fallback）
- §12.1.8（MCP 外部工具）
- §12.1.9（工具循环 5 场景）
- §12.1.10（危险工具拒绝）
- §12.1.11（Provider 选择 UI ✅，实际调用 ❌）
- §12.1.13（上下文注入 L1/L2/L3）
- §12.1.14（write_back）
- §12.1.15（Provider 故障转移）
- §12.1.16（Ollama 本地模型）
- §12.1.17（SSE 错误事件）

### 验收

```
设置页 → 添加或编辑一个 provider → 填入有效 api_key
  → 系统页 provider 状态从 "healthy" 变为实际可用状态
  → 对话页发送消息 → 收到流式 AI 回复（非 PROVIDER_FAIL）
```

---

## §12-THEME-SETTINGS: 设置页主题按钮不生效

**发现于**: §12.8.4 / §12.13 主题切换（2026-05-30）
**分类**: 真 bug（UI 逻辑缺陷）
**严重度**: 🟠 中
**涉及文件**: `apps/web/src/pages/SettingsPage.tsx`
**状态**: ⬜ 待修复

### 现象

| 操作 | 预期 | 实际 |
|---|---|---|
| 点击侧栏"切换主题"按钮 | 主题切换 | ✅ 正常（html class、localStorage、bgColor 全变） |
| 点击设置页"跟随系统/浅色/深色" | 主题切换 | ❌ 按钮 `[active]` 变但 html class、localStorage、bgColor **全不变** |
| 设置页改主题后点"保存" | 主题切换 | ✅ 正常（`handleSubmit` 调 `applyTheme`） |

### 根因

`SettingsPage.tsx` 第 39-40 行：

```tsx
const [locale, setLocale] = useState("zh-CN");
const [theme, setLocalTheme] = useState<string>("system");  // ← 本地 state，只影响 UI
```

`SegmentedField` 的 `onChange` 只更新本地 state（第 164 行）：

```tsx
<SegmentedField onChange={setLocalTheme} />
```

而实际的主题生效函数 `applyTheme`（来自 `useTheme()`）只在 `handleSubmit`（第 116 行）中调用——只有点击底部"保存"按钮才触发。

**对比**：侧栏 `ThemeToggle`（`AppLayout.tsx` 第 163 行）直接调用 `onChange(next[theme])`，而该 `onChange` 就是 `useTheme().setTheme`，它会立即写入 `localStorage` 并更新 `<html>` class。

### 修复方案

让主题按钮像侧栏切换按钮一样**即时生效**。保存操作用于将最终选择持久化到服务端。

**只改 `SettingsPage.tsx`，1 处改动**：

```tsx
// ── 旧（第 156-165 行）──
<SegmentedField
  label={t("settings.theme")}
  value={theme}
  options={[
    { value: "system", label: t("theme.system") },
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
  ]}
  onChange={setLocalTheme}
/>

// ── 新 ──
<SegmentedField
  label={t("settings.theme")}
  value={theme}
  options={[
    { value: "system", label: t("theme.system") },
    { value: "light", label: t("theme.light") },
    { value: "dark", label: t("theme.dark") },
  ]}
  onChange={(v) => {
    setLocalTheme(v);
    applyTheme(v as "system" | "light" | "dark");
  }}
/>
```

**关键点**：
- `setLocalTheme(v)` — 保持按钮 active 态视觉反馈
- `applyTheme(v)` — **即时**写入 `document.documentElement.classList` + `localStorage`
- `handleSubmit` 中保留 `patch({ app: { theme } })` — 服务端持久化（不改）

**原理**：`useTheme` hook（`hooks/useTheme.ts`）内部管理独立的 `ThemeMode` state + localStorage。侧栏切换通过 `setTheme()` 写入，设置页保存时通过 `applyTheme()` 写入同一状态。现在让按钮点击也即时调用 `applyTheme`，三方同步一条状态线。

### 不需要改的

- ❌ 不要改 `useTheme` hook 签名或逻辑
- ❌ 不要改 `SegmentedField` 组件
- ❌ 不要改侧栏 `ThemeToggle`
- ❌ 不要改 `handleSubmit`（它仍然持久化到服务端）

### 验收

```
设置页 → 点击"浅色" → 页面立即变亮 ✅
       → 打开 DevTools → localStorage["knowself-theme"] === "light" ✅
       → 侧栏主题按钮显示太阳图标 ✅
       → 点"保存" → Toast "设置已保存" → 刷新 → 仍是"浅色" ✅
```

---

## §12-I18N-SETTINGS: 设置页语言按钮不生效

**发现于**: §12.8.5 / §12.14 国际化（2026-05-30）
**分类**: 真 bug（UI 逻辑缺陷 — 与 THEME-SETTINGS 同根因）
**严重度**: 🟠 中
**涉及文件**: `apps/web/src/pages/SettingsPage.tsx`
**状态**: ⬜ 待修复

### 现象

| 操作 | 预期 | 实际 |
|---|---|---|
| 设置页点击"中文"/"English" | 全 UI 文案切换 | ❌ 按钮 `[active]` 变但文案全不变 |
| 刷新后 | 语言保持 | ❌ localStorage 无语言相关 key |

### 根因

**双层断裂**：

1. **前端层**：与主题相同——`SegmentedField` 的 `onChange={setLocale}` 只更新本地 `useState`（第 154 行）。I18nProvider 从 `settingsStore.settings.app.locale` 读取 locale（`main.tsx` 第 21 行），本地 state 变更不影响 I18nProvider。

2. **持久化层**：locale 变更只在 `handleSubmit`（第 109-112 行）中 `patch({ app: { locale } })` → `save(transport)` → 服务端落盘 → settingsStore 更新 → I18nProvider 重渲染。完整链路需要一次服务端往返。

### 修复方案

**两个文件，共 3 行改动**。核心：按钮点击 → `patch` 写 dirty → preview 更新 → I18nProvider 即时重渲染。

---

**文件 1 / 2：`apps/web/src/pages/SettingsPage.tsx`**

找到第 147-155 行的语言 `SegmentedField`，只改 `onChange`：

```tsx
// ── 旧 ──
<SegmentedField
  label={t("settings.language")}
  value={locale}
  options={[
    { value: "zh-CN", label: t("settings.lang_zh") },
    { value: "en-US", label: t("settings.lang_en") },
  ]}
  onChange={setLocale}
/>

// ── 新 ──
<SegmentedField
  label={t("settings.language")}
  value={locale}
  options={[
    { value: "zh-CN", label: t("settings.lang_zh") },
    { value: "en-US", label: t("settings.lang_en") },
  ]}
  onChange={(v) => {
    setLocale(v);
    patch({ app: { locale: v as "zh-CN" | "en-US" } });
  }}
/>
```

---

**文件 2 / 2：`apps/web/src/main.tsx`**

改 `AppWithI18n`（第 20-27 行）——当前它从已保存的 `settings` 读 locale，需改为从 `preview`（合并了 dirty）读：

```tsx
// ── 旧 ──
import { useSettingsStore } from "./stores/settings";
// ...（文件中间）
function AppWithI18n() {
  const locale = useSettingsStore((s) => s.settings?.app?.locale ?? "zh-CN");
  return (
    <I18nProvider locale={locale}>
      <App />
    </I18nProvider>
  );
}

// ── 新 ──
import { useSettingsStore, useSettingsPreview } from "./stores/settings";
// ...（文件中间）
function AppWithI18n() {
  const preview = useSettingsPreview();
  const locale = preview?.app?.locale ?? "zh-CN";
  return (
    <I18nProvider locale={locale}>
      <App />
    </I18nProvider>
  );
}
```

改动明细：
- 第 8 行 import：`useSettingsStore` → `useSettingsStore, useSettingsPreview`（追加导入）
- 第 21 行：`useSettingsStore((s) => s.settings?.app?.locale)` → `useSettingsPreview()?.app?.locale`

---

**关键数据流**（为什么这两处就够了）：

`patch({ app: { locale: "en-US" } })` → `dirty.app.locale = "en-US"`（`stores/settings.ts` 第 74-107 行 `patch` 函数）→ `useSettingsPreview()` 调用 `mergeDirty(settings, dirty)`（第 126-131 行）→ `{ ...settings.app, ...pickDefined(dirty.app) }`（第 23-24 行）→ `app.locale = "en-US"` → `I18nProvider` 收到新 locale → `useMemo` 切换字典 → 所有 `useT()` 消费者重渲染。

### 边界

- ❌ 不要移除 SettingsPage 的 locale `useEffect` 同步（第 53-58 行，它处理页面初始加载时把已存储 locale 同步到本地 state）
- ❌ 不要删 `handleSubmit`（第 106-122 行）中的 `patch` + `save` —— 它负责服务端持久化
- ❌ 不要改 `I18nProvider`（`lib/i18n.ts`）
- ❌ 不要改 `useSettingsPreview` 或 `mergeDirty`

### 验收

```
设置页 → 点击"English" → 所有 UI 文案立即切换为英文 ✅
       → 侧栏导航标签变为英文 ✅
       → 系统页标签变为英文 ✅
       → 点"保存" → F5 刷新 → 仍是英文 ✅
       → 再次进入设置页 → 点击"中文" → 所有文案立即切回中文 ✅
```

---

## §12-URL-ROUTING: SPA 无 URL 路由 — 直接访问/刷新均回对话页

**发现于**: §12.12.3 刷新持久性（2026-05-30）
**分类**: 真 bug（架构缺失）
**严重度**: 🔴 高
**涉及文件**: `apps/web/src/App.tsx`
**状态**: ⬜ 待修复

### 现象

| 操作 | 预期 | 实际 |
|---|---|---|
| 侧栏按钮切换页面 | ✅ | ✅ |
| 直接访问 `http://127.0.0.1:5173/settings` | 设置页 | ❌ 对话页 |
| 直接访问 `http://127.0.0.1:5173/tokens` | Token 统计页 | ❌ 对话页 |
| 刷新任意非首页 | 停留当前页 | ❌ 回到对话页 |
| 浏览器后退/前进 | 切换页面 | ❌ 不切换 |

### 根因

`App.tsx` 第 49 行：

```tsx
const [currentPage, setCurrentPage] = useState<PageId>("chat");
```

- 无 react-router / TanStack Router
- 无 `window.location.hash` 读写
- 无 `history.pushState` / `popstate` 监听
- 初始值硬编码为 `"chat"`，不读 URL

导航仅通过 `handleNavigate` → `setCurrentPage(page)` 进行，这是纯内存状态。

### 修复方案

**采用 hash-based 路由（最简方案）**。

不需要引入任何路由库。利用 `window.location.hash` + `hashchange` 事件即可实现所有需求：

- 页面切换 → 更新 hash（`#settings`、`#journal`）
- 直接访问 → 从 hash 读取初始页面
- 浏览器后退/前进 → `hashchange` 事件驱动页面切换
- 刷新 → hash 保留，读取并恢复

**改动全在 1 个文件：`apps/web/src/App.tsx`。**

---

**Step 1 — 在 `PAGE_MAP` 定义之后、`export function App()` 之前，插入 3 个工具函数**

插入位置：第 34 行之后（`};` 闭合 PAGE_MAP 之后）：

```tsx
};

// ── 新增：hash ↔ PageId 工具 ──
const VALID_PAGES = new Set<PageId>([
  "chat", "profile", "cards", "journal", "settings",
  "system", "sources", "templates", "token-stats",
]);

function pageFromHash(): PageId {
  const raw = window.location.hash.slice(1); // 去掉开头的 #
  return VALID_PAGES.has(raw as PageId) ? (raw as PageId) : "chat";
}

function syncHash(page: PageId) {
  if (window.location.hash.slice(1) !== page) {
    window.location.hash = page;
  }
}

export function App() {
```

---

**Step 2 — 修改 `useState` 初始值（第 49 行）**

```tsx
// ── 旧 ──
const [currentPage, setCurrentPage] = useState<PageId>("chat");

// ── 新 ──
const [currentPage, setCurrentPage] = useState<PageId>(pageFromHash);
```

---

**Step 3 — 在 `handleNavigate` 回调内追加 URL 同步（第 53-55 行）**

```tsx
// ── 旧 ──
const handleNavigate = useCallback((page: PageId) => {
  setCurrentPage(page);
}, []);

// ── 新 ──
const handleNavigate = useCallback((page: PageId) => {
  setCurrentPage(page);
  syncHash(page);
}, []);
```

---

**Step 4 — 在现有键盘快捷键 `useEffect` 之后追加 `hashchange` 监听（第 76 行之后）**

```tsx
  }, [startConversation]);

  // ── 新增：监听浏览器后退/前进 ──
  useEffect(() => {
    const onHashChange = () => setCurrentPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const PageComponent = PAGE_MAP[currentPage];
```

### 为什么不用 react-router

- 当前 9 个页面之间没有嵌套路由、参数传递、数据预加载需求
- react-router 会引入 ~30KB gzipped + 概念负担（BrowserRouter、Routes、Route、Outlet、useParams...）
- hash 路由 ~30 行代码满足全部需求
- 未来如需升级到 TanStack Router（已列入技术栈），hash 路由可以零摩擦替换

### 验收

```
浏览器打开 http://127.0.0.1:5173 → URL 变为 /#chat → 显示对话页 ✅
直接访问 /#settings → 显示设置页 ✅
直接访问 /#journal → 显示日记页 ✅
点击侧栏"系统状态" → URL 变为 /#system → 页面切换 ✅
按 F5 刷新 → 仍在系统状态页 ✅
按浏览器后退 → 回到上一页 ✅
访问 /#bogus → 回退到对话页（兜底）✅
```

---

## §12-STATUS-MISMATCH: 侧栏状态指示器与系统页不一致

**发现于**: §12.9 系统状态（2026-05-30）
**分类**: 真 bug（UI 一致性问题）
**严重度**: 🟡 低
**涉及文件**: `apps/web/src/pages/SystemPage.tsx`（+ `apps/web/src/components/AppLayout.tsx` 供参考）
**状态**: ⬜ 待修复

### 现象

两个 provider 均 API 认证失败（HTTP 401 / HTTP 404）：
- 侧栏 `StatusPill`：显示 **"异常"**（dead）
- 系统页 Overall 卡片：显示 **"正常"**（healthy）
- 矛盾信息让用户困惑

### 根因

两处使用**完全不同的健康判定标准**：

**侧栏**（`AppLayout.tsx` 第 62-69 行）：
```tsx
const overallState = (() => {
  if (!status) return "starting";
  if (!status.ready.overall) return "starting";
  const providerStates = status.providers.map((p) => p.state);
  if (providerStates.some((s) => s === "dead")) return "dead";        // ← 检查 provider
  if (providerStates.some((s) => s === "degraded")) return "degraded";
  return "healthy";
})();
```
检查了 3 层：`ready.overall` + provider 存活 + provider 降级。

**系统页**（`SystemPage.tsx` 第 84-89 行）：
```tsx
<StatCard
  label={t("system.overall")}
  value={status.ready.overall ? t("system.healthy") : t("system.not_ready")}
  tone={status.ready.overall ? "success" : "warning"}
/>
```
只检查 `ready.overall` 布尔值。`ready.overall` 为 `true` 时 providers 可能全部 dead。

### 修复方案

**让系统页的 Overall 卡片使用与侧栏相同的健康判定逻辑**。

方案：从 `AppLayout` 中提取 `overallState` 推导逻辑为共享函数，或直接在 `SystemPage` 中复制相同逻辑。

**只改 1 个文件：`apps/web/src/pages/SystemPage.tsx`。**

---

**Step 1 — 在组件函数顶部（`export function SystemPage()` 之内）新增健康判定逻辑**

插入位置：第 29 行之后（`if (loading && !status)` 之前）。即放在 `useEffect` 之后、第一个条件 return 之前，确保 `status` 已可用：

```tsx
  // ── 新增：与 AppLayout 侧栏相同的健康判定 ──
  const overallHealth = (() => {
    if (!status.ready.overall) return "starting" as const;
    const states = status.providers.map((p) => p.state);
    if (states.some((s) => s === "dead")) return "dead" as const;
    if (states.some((s) => s === "degraded")) return "degraded" as const;
    return "healthy" as const;
  })();

  // 复用已有的 status_pill.* 翻译 key（zh-CN: 正常/降级/异常/启动中）
  const HEALTH_LABEL: Record<string, string> = {
    healthy: t("status_pill.healthy"),
    degraded: t("status_pill.degraded"),
    dead: t("status_pill.dead"),
    starting: t("status_pill.starting"),
  };
  const HEALTH_TONE: Record<string, "success" | "warning" | "danger"> = {
    healthy: "success",
    degraded: "warning",
    dead: "danger",
    starting: "warning",
  };
```

---

**Step 2 — 替换 Overall StatCard（第 83-89 行）**

```tsx
// ── 旧 ──
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              icon={<Activity className="size-4" strokeWidth={2} />}
              label={t("system.overall")}
              value={status.ready.overall ? t("system.healthy") : t("system.not_ready")}
              tone={status.ready.overall ? "success" : "warning"}
            />

// ── 新 ──
          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              icon={<Activity className="size-4" strokeWidth={2} />}
              label={t("system.overall")}
              value={HEALTH_LABEL[overallHealth]}
              tone={HEALTH_TONE[overallHealth]}
            />
```

其他两个 StatCard（uptime、version）**不动**。

---

**为什么用 `status_pill.*` 而不是新建 `system.*` key**：`status_pill.healthy/degraded/dead/starting` 已在 `zh-CN.json`（第 270-273 行）和 `en-US.json`（第 270-273 行）中存在。侧栏 `StatusPill` 组件用的就是这些 key。复用它们保证侧栏和系统页**显示完全相同的文字**，不需要改任何 locale 文件。

**长期优化**（不在本次范围）：
将 `overallState` 推导提取为一个共享 selector（如 `useSystemHealth()`），`AppLayout` 和 `SystemPage` 共同引用，避免逻辑重复。

### 边界

- ❌ 不要改 `AppLayout` 的侧栏逻辑（它已经正确）
- ❌ 不要改后端 `ready.overall` 的返回值语义
- ❌ 不要改 `StatCard` 组件

### 验收

```
系统页 → 有 provider 返回 dead/degraded 状态时
       → Overall 卡片应与侧栏 StatusPill 显示一致
       → 不应再出现侧栏"异常" + 系统页"正常"的矛盾
```

---

## §12-JOURNAL-SIDEBAR: 日记侧栏计数追加后不实时更新

**发现于**: §12.5.2 新增日记（2026-05-30）
**分类**: 真 bug（store 数据流缺陷）
**严重度**: 🟡 低
**涉及文件**: `apps/web/src/stores/profile.ts`（根因）、`apps/web/src/pages/JournalPage.tsx`（冗余调用）
**状态**: ⬜ 待修复

### 现象

- 追加一条日记后 → 右侧内容区显示"1 条" ✅
- 左侧日期列表对应日期的 Badge 仍显示旧计数（如"0"）❌
- 刷新页面后计数正确

### 根因

`loadJournal`（`profile.ts` 第 158-176 行）：

```ts
loadJournal: async (date, t) => {
  const full = await t.getJournal(date);
  const updated = new Map(get().journals);
  const entry = updated.get(date);
  updated.set(date, {
    summary: entry?.summary ?? {          // ← BUG: entry 存在时用旧 summary
      date: full.date,
      record_count: full.records.length,   // 新计数只在 entry 不存在时生效
      updated_at: new Date().toISOString(),
    },
    full,
  });
  set({ journals: updated, loading: false });
},
```

当日期**已经存在于** `journals` Map 中时（即 `entry` 不为 `undefined`），`entry?.summary` 返回的是 `loadJournalList` 时的**旧** `record_count`。`full.records.length`（新计数）只有在 `entry` 不存在时（`??` 右值）才会被使用。

**流程图**：

```
loadJournalList (mount) → journals["2026-05-30"] = { summary: { date, record_count: 0 } }
                                                      ↑ 旧值，count 为 0
用户追加一条 →
  appendJournal → loadJournal
    → full.records.length = 1  ← API 返回新数据
    → entry?.summary = { record_count: 0 }  ← 命中 ?? 左侧，旧值被保留
    → 侧栏 badge: 0  ← 显示旧值 ❌
    → 内容区: full.records.length = 1  ← 直接读 full，显示正确 ✅
```

**为什么内容区显示正确**：内容区读 `selectedFull.records.length`（来自 `journalsMap.get(date)?.full`），`full` 每次从 API 拉取，所以计数正确。侧栏读 `journalEntries[].summary.record_count`，`summary` 只在 `entry` 不存在时重建。

### 修复方案

**改 `profile.ts` 的 `loadJournal`，1 行**：

```ts
// ── 旧（第 162-171 行）──
const updated = new Map(get().journals);
const entry = updated.get(date);
updated.set(date, {
  summary: entry?.summary ?? {
    date: full.date,
    record_count: full.records.length,
    updated_at: new Date().toISOString(),
  },
  full,
});

// ── 新 ──
const updated = new Map(get().journals);
updated.set(date, {
  summary: {
    date: full.date,
    record_count: full.records.length,          // ← 始终用最新值
    updated_at: new Date().toISOString(),
  },
  full,
});
```

**关键**：移除 `entry?.summary ??` 兜底，每次都从 API 返回的 `full` 重建 `summary`。`record_count` 始终等于 `full.records.length`。

**附带清理**：`JournalPage.tsx` 的 `handleAppend`（第 55-74 行）中，`appendJournal` 已经在 store 内部调用了 `loadJournal`（`profile.ts` 第 183 行），所以第 71 行的 `await loadJournal(selectedDate, transport)` 是**冗余调用**，可删除：

```tsx
// ── handleAppend 末尾 ──
await appendJournal(selectedDate, newEntry.trim(), tagList, transport);
setNewEntry("");
setTags("");
// await loadJournal(selectedDate, transport);  ← 删除此行（appendJournal 内部已做）
```

不过保留它也无功能错误，只是多发一次 API 请求。可在本次顺手清理。

### 边界

- ❌ 不要改 `loadJournalList` 逻辑
- ❌ 不要改 `appendJournal` 的 API 调用顺序
- ❌ 不要改 JournalPage 的渲染结构

### 验收

```
日记页 → 选择一个日期（0 条记录）
       → 输入内容 → 点"追加日记"
       → 左侧日期 Badge 从 0 变为 1 ✅
       → 右侧内容区显示"1 条" ✅
       → 再追加一条 → Badge 变为 2 ✅
       → 切换到另一日期再切回来 → Badge 仍为 2 ✅
```

---

## 总结

| # | ID | 严重度 | 涉及文件数 | 代码改动量 | 修复方式 |
|---|---|---|---|---|---|
| 1 | §12-PROVIDER | 🔴 高 | 0（操作） | 0 | 填入有效 api_key |
| 2 | §12-THEME-SETTINGS | 🟠 中 | 1 | +1 行 | `onChange` 加 `applyTheme(v)` |
| 3 | §12-I18N-SETTINGS | 🟠 中 | 2 | +3 行 | `onChange` 加 `patch()` + `main.tsx` 改用 preview |
| 4 | §12-URL-ROUTING | 🔴 高 | 1 | 4 步 | hash 路由：工具函数 + useState 初值 + syncHash + hashchange |
| 5 | §12-STATUS-MISMATCH | 🟡 低 | 1 | 2 步 | 新增判定逻辑 + 替换 StatCard value/tone |
| 6 | §12-JOURNAL-SIDEBAR | 🟡 低 | 1 | 删 2 行 + 删 1 行冗余 | `loadJournal` 始终重建 summary + 移除冗余 API 调用 |

**建议修复顺序**：§12-PROVIDER（先解锁聊天测试）→ §12-URL-ROUTING → §12-THEME-SETTINGS → §12-I18N-SETTINGS → §12-JOURNAL-SIDEBAR → §12-STATUS-MISMATCH
