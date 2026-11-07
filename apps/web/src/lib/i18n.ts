import { createContext, createElement, useContext, useMemo } from "react";
import zhCN from "../locales/zh-CN.json";
import enUS from "../locales/en-US.json";

const dicts: Record<string, Record<string, string>> = {
  "zh-CN": zhCN as Record<string, string>,
  "en-US": enUS as Record<string, string>,
};
const Ctx = createContext<{ t: (key: string, vars?: Record<string, string>) => string }>({
  t: (k) => k,
});

export function I18nProvider({ locale, children }: { locale: string; children: React.ReactNode }) {
  const t = useMemo(() => {
    const dict: Record<string, string> = dicts[locale] ?? zhCN;
    return (key: string, vars?: Record<string, string>) => {
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
      return s;
    };
  }, [locale]);
  return createElement(Ctx.Provider, { value: { t } }, children);
}

export function useT() {
  return useContext(Ctx).t;
}
