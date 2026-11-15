/**
 * 首次启动自举：`settings.json` 缺失时写入一份默认配置。
 *
 * 为什么需要它（0.3.6）：
 *   插件入口 `apply()` 在装配失败时是"降级为不注册任何扩展"，而 `loadSettings()`
 *   在文件不存在时抛 `SettingsParseError`。结果是**全新安装（根目录连 settings.json
 *   都没有）会让整个插件不注册** —— 表现为 `/knowself-api/*` 全部 404/405，
 *   用户看到的不是"还没配置"，而是"这个功能不存在"。
 *
 * 取舍：默认配置直接从示例（`settings-example.json`，随 bundle 内联）复制，
 *   而不是在代码里手搓一份最小骨架 —— 后者会在 schema 演进后悄悄与真实配置漂移。
 *   示例里的 api_key 是占位值，装配阶段不校验；真正调用模型时才会报鉴权错。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import exampleSettings from "./settings-example.json";

const SETTINGS_FILENAME = "settings.json";

export interface SettingsBootstrapResult {
  /** 本次是否新建了 settings.json */
  readonly created: boolean;
  /** 写入后的绝对路径 */
  readonly path: string;
}

/**
 * 确保 `rootDir/settings.json` 存在。存在则原样返回，不做任何读写。
 *
 * 只做一件事，不做 schema 校验：校验由 `loadSettings()` 负责，
 * 这样"文件坏了"与"文件没有"两种故障不会在这里被混为一谈。
 */
export function ensureSettingsFile(rootDir: string): SettingsBootstrapResult {
  const path = join(rootDir, SETTINGS_FILENAME);
  if (existsSync(path)) return { created: false, path };

  mkdirSync(rootDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(exampleSettings, null, 2)}\n`, "utf-8");
  return { created: true, path };
}
