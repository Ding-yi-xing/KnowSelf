/**
 * 插件 Config（W2/T04）——只放**宿主相关旋钮**。
 *
 * 约定（05 §7 V6）：`Config` 只放宿主旋钮（面板/降级状态/检索条数等）；
 * 领域配置（provider、路径、检索参数等）**一律以 `settings.json` 为准**，
 * `Config` 不复制，避免「改一处不生效」的配置双源。
 *
 * 契约依据（逐行核实安装版本）：
 *   `@deepseek-ai/schemastery@3.19.0/lib/types/index.d.ts`
 *     :30-88 `Schemastery.Static`（object/string/number/boolean/union）
 *     :169-176 实例方法 `.default()` / `.description()`
 *     :209-210 `declare const Schema: Schemastery.Static; export default Schema`
 *     :127-145 `Schemastery` 实例带 `'~standard'`，与 cordis
 *              `Plugin.Base.Config?: StandardSchemaV1<any, T>` 兼容。
 *   本机实跑：`typeof require('@deepseek-ai/schemastery') === 'function'`，
 *   且 `.object/.string/.number/.boolean/.union` 均可用（主理人 F8 已核实）。
 */
import Schema from "@deepseek-ai/schemastery";

/** 宿主旋钮（领域配置不在此重复）。 */
export interface Config {
  /** 资料根目录（留空用领域库默认）。 */
  sourcesDir?: string;
  /**
   * persons 加密密钥载体（MD2-4 / OPEN-3）：
   *   - `auto`：环境变量 > 密钥文件 > 装配期自动生成（默认，桌面/新机无人值守）；
   *   - `env` ：只用环境变量 `KNOWSELF_PERSONS_KEY`，缺失即人物层降级；
   *   - `file`：只用密钥文件（原严格行为），缺失即人物层降级，绝不生成。
   */
  personsKeyMode?: "auto" | "env" | "file";
  /** 检索返回条数。 */
  retrievalTopK?: number;
  /** 是否启用数据挖掘工具。 */
  enableMining?: boolean;
}

/**
 * 设置页字段 schema。用 `Schema.object` 生成，四个字段均带 description，
 * 且带运行时默认值（personsKeyMode / retrievalTopK / enableMining）。
 * `personsKeyMode` 默认 `auto`：装配期自动生成，避免桌面首启人物面板永远 503。
 */
export const Config = Schema.object({
  sourcesDir: Schema.string().description("资料根目录（留空用默认）"),
  personsKeyMode: Schema.union(["auto", "env", "file"])
    .default("auto")
    .description("persons 密钥载体（auto=自动生成，env=仅环境变量，file=仅密钥文件）"),
  retrievalTopK: Schema.number().default(8).description("检索返回条数"),
  enableMining: Schema.boolean().default(false).description("启用数据挖掘工具"),
});

export {};
