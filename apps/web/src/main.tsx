/**
 * 浏览器入口 —— 独立 React 壳。
 *
 * 与 dsh `apps/web/src/main.ts` 的差别：不构造 `AppWebEntry`、不读取
 * `window.__DSH_BOOT__` / `__DSH_TRANSPORT__`，直接 createRoot。
 * 这是 B1 裁剪的核心：knowSelf 前端不依赖 dsh 的 agent host 启动链。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("knowSelf web: #root is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
