import { useEffect, useState, useCallback } from "react";
import type { ThemeMode } from "@knowself/contracts";
import { useSettingsStore } from "../stores/settings";

const STORAGE_KEY = "knowself-theme";

/**
 * 主题管理 hook：system / light / dark 切换 + 持久化到 localStorage。
 * 在 <html> 上设置 class（"dark" / "light" / ""）驱动 Tailwind dark: 前缀。
 */
export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    return (localStorage.getItem(STORAGE_KEY) as ThemeMode) ?? "system";
  });

  // 根据主题设置 <html> class
  const applyTheme = useCallback((mode: ThemeMode) => {
    const root = document.documentElement;
    if (mode === "dark") {
      root.classList.add("dark");
    } else if (mode === "light") {
      root.classList.remove("dark");
    } else {
      // system
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      if (prefersDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme, applyTheme]);

  // 当 settings 加载后，优先用后端存储的主题
  const settingsTheme = useSettingsStore((s) => s.settings?.app?.theme);
  useEffect(() => {
    if (settingsTheme && settingsTheme !== theme) {
      setThemeState(settingsTheme);
      localStorage.setItem(STORAGE_KEY, settingsTheme);
    }
  }, [settingsTheme]); // eslint-disable-line

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    localStorage.setItem(STORAGE_KEY, mode);
  }, []);

  return { theme, setTheme };
}
