/**
 * W-9：**挖掘状态与触发**的只读/写端口（client 侧）。
 *
 * ## 为什么单独一个端口
 * 图谱面板要判「有没有数据 / 挖没挖过」，而 `GraphPanelPayload` 是**图的形状**（主理人裁定：
 * 图归图、状态归状态）。所以状态走 `GET /mining/status`，触发走
 * `POST /write/mining-run`（写通道，需 `x-knowself-write: 1`）。
 *
 * ## 写通道约定
 * 与 W-1 一致：写端点只在 `/knowself-api/write/*` 上可达，且必须带 `x-knowself-write: 1`，
 * 否则宿主 405/403。这里统一封装，面板不直接拼 fetch。
 */

/** `GET /mining/status` 的响应。 */
export interface MiningStatus {
  has_snapshot: boolean;
  snapshot_id: string | null;
  node_count: number;
  edge_count: number;
  chat_message_count: number;
  chat_conversation_count: number;
  person_count: number;
}

/** `POST /write/mining-run` 的响应。 */
export interface MiningRunResult {
  snapshot_id: string | null;
  nodes: number | null;
  edges: number | null;
  persons: number;
  scopes: number;
  warnings: string[];
}

/** 挖掘状态/触发端口。 */
export interface MiningPort {
  /** 读状态（只读）。 */
  getStatus(): Promise<MiningStatus>;
  /** 触发一次挖掘（写通道）。 */
  run(): Promise<MiningRunResult>;
}

/** 写通道要求的自定义头。 */
const WRITE_HEADERS = { "content-type": "application/json", "x-knowself-write": "1" } as const;

/**
 * 构造 REST 端口。
 * @param baseUrl REST 前缀，默认同 origin `/knowself-api`
 * @returns 挖掘端口
 */
export function createRestMiningPort(baseUrl = "/knowself-api"): MiningPort {
  return {
    async getStatus(): Promise<MiningStatus> {
      const res = await fetch(`${baseUrl}/mining/status`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`GET ${baseUrl}/mining/status → ${res.status}`);
      return (await res.json()) as MiningStatus;
    },
    async run(): Promise<MiningRunResult> {
      const res = await fetch(`${baseUrl}/write/mining-run`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: "{}",
      });
      if (!res.ok) throw new Error(`POST ${baseUrl}/write/mining-run → ${res.status}`);
      return (await res.json()) as MiningRunResult;
    },
  };
}
