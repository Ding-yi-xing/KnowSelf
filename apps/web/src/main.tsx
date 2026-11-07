/**
 * apps/web/src/main.tsx — React 入口。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { getTransport } from "./transport";
import { TransportProvider } from "./stores/transport-context";
import { useSettingsStore } from "./stores/settings";
import { I18nProvider } from "./lib/i18n";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("缺少 #root 挂载点");
}

const transport = getTransport();

function AppWithI18n() {
  const locale = useSettingsStore((s) => s.settings?.app?.locale ?? "zh-CN");
  return (
    <I18nProvider locale={locale}>
      <App />
    </I18nProvider>
  );
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <TransportProvider transport={transport}>
      <AppWithI18n />
    </TransportProvider>
  </React.StrictMode>,
);
