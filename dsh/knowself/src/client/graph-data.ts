/**
 * 图谱面板的**取数钩子**（C3 从 `graph-panel.tsx` 搬出，纯搬家）。
 *
 * 面板主文件只该描述"怎么编排"，不该被两段几乎同构的 `useEffect + cancelled` 占掉 50 行。
 * 这里把三件事搬出来：
 *   ① graph 取数（含过滤时额外取一次未过滤结果，用于收集边类型清单）；
 *   ② mining 状态（与 ① 并行，失败只影响判定精度）；
 *   ③ 订阅"别人改了挖掘数据"的刷新信号。
 *
 * **行为与搬家前逐字一致**：取消语义（`cancelled`）、依赖数组、失败时 `payload=null`
 * 的顺序都没有改动。改动这些会直接改变竞态表现，不属于"搬家"。
 */
import { useEffect, useState } from "react";
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelPayload, KnowselfGraphPort } from "./graph-port.js";
import type { MiningPort, MiningStatus } from "./mining-port.js";
import { subscribeMiningRefresh } from "./mining-refresh.js";
import { collectEdgeKinds } from "./graph-filter.js";
import { mergeKinds, type PanelFailure } from "./graph-panel-helpers.js";

/** `useGraphPayload` 的结果。 */
export interface GraphPayloadState {
  /** 最近一次成功取到的数据（失败时会被置 null）。 */
  payload: GraphPanelPayload | null;
  /** 是否取数中。 */
  loading: boolean;
  /** 失败态（与 payload 互斥）。 */
  failure: PanelFailure | null;
  /** 曾出现过的边类型（累加，过滤不会让它变少）。 */
  knownKinds: GraphEdgeKind[];
}

/**
 * 取 graph 数据。
 *
 * @param input.port 只读图谱端口
 * @param input.kindsKey 过滤键（空串 = 不过滤）；用字符串而非数组做依赖，避免无限重取
 * @param input.reloadToken 手动重取令牌
 * @param input.toFailure 错误 → 失败态（由面板注入，保持错误语义与其它面板一致）
 * @returns 见 {@link GraphPayloadState}
 */
export function useGraphPayload(input: {
  port: KnowselfGraphPort;
  kindsKey: string;
  reloadToken: number;
  toFailure: (err: unknown) => PanelFailure;
}): GraphPayloadState {
  const { port, kindsKey, reloadToken, toFailure } = input;
  const [payload, setPayload] = useState<GraphPanelPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [failure, setFailure] = useState<PanelFailure | null>(null);
  const [knownKinds, setKnownKinds] = useState<GraphEdgeKind[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailure(null);
      try {
        const next =
          kindsKey === ""
            ? await port.getGraph()
            : await port.getGraph({ edge_kinds: kindsKey.split(",") as GraphEdgeKind[] });
        if (cancelled) return;
        setPayload(next);
        // 过滤生效时，本次响应的边只含被选类型 —— 复选框会因此「越选越少」，
        // 刷新后连取消勾选的入口都没了。所以额外取一次**未过滤**结果，
        // 只用于收集「有哪些边类型」这个清单。
        const inventory = kindsKey === "" ? next : await port.getGraph();
        if (cancelled) return;
        setKnownKinds((prev) => mergeKinds(prev, collectEdgeKinds(inventory.edges)));
      } catch (err) {
        if (!cancelled) {
          setFailure(toFailure(err));
          setPayload(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // kindsKey 已覆盖 selectedKinds 的内容变化
  }, [port, reloadToken, kindsKey, toFailure]);

  return { payload, loading, failure, knownKinds };
}

/**
 * 取挖掘状态（W-9：空态判定树的第 1/2 分支数据源）。
 *
 * 失败**不抛**：状态端点挂了只降低判定精度（面板退回"只看 graph"），
 * 不该把整个图谱面板打成错误态。
 *
 * @param input.mining 挖掘端口
 * @param input.reloadToken 手动重取令牌（与 graph 同步）
 * @returns 状态；`null` 表示不可用
 */
export function useMiningStatus(input: { mining: MiningPort; reloadToken: number }): MiningStatus | null {
  const { mining, reloadToken } = input;
  const [status, setStatus] = useState<MiningStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await mining.getStatus();
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mining, reloadToken]);
  return status;
}

/**
 * 订阅"别人（资料面板导入 / 批量采纳）改了挖掘数据"的刷新信号。
 * @param onRefresh 收到信号时调用（面板传 `reload`）
 */
export function useMiningRefreshSignal(onRefresh: () => void): void {
  useEffect(() => subscribeMiningRefresh(onRefresh), [onRefresh]);
}
