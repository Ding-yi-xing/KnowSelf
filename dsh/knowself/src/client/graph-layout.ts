/**
 * 图谱**力导向布局**（纯函数，零依赖、可在 node 里单测）。
 *
 * ## 为什么要一个独立模块
 * 布局是纯计算（一堆坐标），绘制是 I/O（canvas）。分开后：
 *   - 布局可被 node 环境直接单测（不需要 jsdom / canvas / 真实像素）；
 *   - 面板组件只负责「取数 → 布局 → 绘制 → 三态」，逻辑不互相纠缠；
 *   - **不引入 d3 / sigma / 任何图谱库**（dsh web 打包环境的虚拟模块兼容性未评估，
 *     且本例只需 FR 力导向 + 直线 + 圆，几十行纯数学即可）。
 *
 * ## 算法（Fruchterman–Reingold 变体，05 §14 面板约束）
 *   - **斥力**：任意两点间 `f = k² / d`（Coulomb 型），把节点推开；
 *   - **弹簧**：每条边 `f = d² / k`（Hooke 型），把有关系的节点拉近；
 *   - **向心**：每轮额外施加一个指向世界中心的微弱力（`centerStrength`），
 *     防止孤立簇无限漂移，并保持布局重心稳定；
 *   - **降温**：第 i 轮的单步位移上限 `t = t0 · (1 - i/iterations) + 0.5`，
 *     先粗后细，约 200 轮后收敛（`DEFAULT_ITERATIONS`）。
 *
 * ## 确定性（不变量 #6：不猜 / 可复现）
 * 初始位置由节点 id 的 FNV-1a 哈希派生（**不用 `Math.random`**），
 * 因此同一份快照每次布局结果完全一致——截图比对、问题复现都不受随机数影响。
 *
 * ## 规模闸门
 * 契约允许 3000 节点 / 10000 边，但 `O(n² × 迭代)` 的纯 JS 布局在 3000 节点上会卡死
 * 主线程。本模块按 `size`（其次 `degree`、再其次 `id` 字典序）**降序取前
 * {@link MAX_RENDER_NODES} 个节点**，并丢弃端点被省略的边，把 `droppedNodes` /
 * `droppedEdges` 如实返回给面板显示（不装作「全画了」）。
 */
import type { GraphEdgeKind } from "@knowself/contracts";
import type { GraphPanelNodeKind } from "./graph-port.js";
import type { GraphPanelEdge, GraphPanelNode } from "./graph-port.js";

/** 单次布局最多参与的节点数（超出按 size 降序截断，见模块头注）。 */
export const MAX_RENDER_NODES = 200;

/** 缺省迭代轮数（≈200 轮后位移收敛到亚像素级）。 */
export const DEFAULT_ITERATIONS = 200;

/** 布局输入：画布尺寸 + 画布 DTO（来自 `graph-port.ts`）。 */
export interface GraphLayoutInput {
  nodes: readonly GraphPanelNode[];
  edges: readonly GraphPanelEdge[];
  width: number;
  height: number;
}

/** 布局可调参数（测试可注入更小迭代数以便快速断言）。 */
export interface GraphLayoutOptions {
  /** 迭代轮数（默认 {@link DEFAULT_ITERATIONS}）。 */
  iterations?: number;
  /** 向心力系数（默认 0.02；0 = 完全不向心）。 */
  centerStrength?: number;
  /** 斥力倍率（默认 1；0 = 无斥力，2 = 两倍）。 */
  repulsion?: number;
  /** 弹簧（连力）倍率（默认 1；0 = 无拉力，2 = 两倍）。 */
  linkStrength?: number;
  /** 理想边长（像素；默认 `sqrt(width·height/count)`，即 FR 的 `k`）。 */
  linkDistance?: number;
  /** 节点半径倍率（默认 1；设置面板「节点大小」滑杆映射）。 */
  nodeSizeScale?: number;
  /** 初始世界坐标的安全边距（默认 28px；不限制最终节点坐标）。 */
  padding?: number;
  /** 参与布局的节点上限（默认 {@link MAX_RENDER_NODES}）。 */
  maxNodes?: number;
  /**
   * 径向布局中心节点 id（可选）。给了就用「社区分组扇区 + 同心环」的放射布局
   * （中心必须放这个节点），而不是力导向。「仅与我直接关系」用它把「我」钉在正中心。
   */
  radialCenterId?: string;
}

/** 布局后的节点（世界坐标 + 像素半径）。 */
export interface GraphLayoutNode {
  id: string;
  label: string;
  /** 与 `GraphPanelNodeKind` 同域（含前端聚合出来的 `community`）。 */
  kind: GraphPanelNodeKind;
  x: number;
  y: number;
  /** 像素半径（已含 `nodeSizeScale`；`size` / `degree` 归一映射，见 {@link nodeRadiusByDegree}）。 */
  radius: number;
  isolated: boolean;
  /** 度数（原样透传，供悬停 / 调试 / 尺寸推断使用）。 */
  degree: number;
  /** 社区键（原样透传，供「按社区上色」使用）。 */
  communityKey: string | null;
  /**
   * 视觉显著性 `[0,1]`：人物/群/话题 = `degree / maxDegree`；社区超节点 = `size`。
   * 供需要比较节点权重的调用方使用；不会影响标签可见性。
   */
  prominence: number;
}

/** 布局后的边（已展开成线段两端坐标）。 */
export interface GraphLayoutEdge {
  id: string;
  kind: GraphEdgeKind;
  strength: number;
  /**
   * 起点节点 id（W-2 加法字段）。
   *
   * 绘制本身不需要它（坐标已在下面），但**悬停邻接高亮**必须知道
   * 「这条边连着谁」——只有端点坐标算不出归属。
   */
  source: string;
  /** 终点节点 id（W-2 加法字段，用途同上）。 */
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 布局结果。 */
export interface GraphLayoutResult {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  /** 因渲染上限被省略的节点数。 */
  droppedNodes: number;
  /** 因任一端点被省略而丢弃的边数。 */
  droppedEdges: number;
}

/**
 * FNV-1a 32 位哈希（确定性伪随机源；相同 id 恒得相同值）。
 * @param text 节点 id
 * @returns `[0, 2^32)` 的无符号整数
 */
function hash32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * 把哈希值映射到 `[0,1)`（两个不同盐位，用于角度 / 半径两个自由度）。
 * @param hash {@link hash32} 的结果
 * @param salt 扰动盐（0 或 1）
 * @returns `[0,1)` 的小数
 */
function hashFraction(hash: number, salt: number): number {
  const mixed = (hash ^ Math.imul(salt + 1, 2654435761)) >>> 0;
  return (mixed % 100_000) / 100_000;
}

/**
 * 节点像素半径：`5 + size·11`（下限 3px；`size` 由 mining 归一化到 `[0,1]`，不重算）。
 * 社区超节点仍用它：超节点的 `size` 已经编码「成员数 ∝ 半径」（见 `graph-community-view.ts`）。
 * @param size 归一化半径
 * @returns 像素半径
 */
export function nodeRadius(size: number): number {
  const clamped = Number.isFinite(size) ? Math.min(1, Math.max(0, size)) : 0;
  return Math.max(3, 5 + clamped * 11);
}

/**
 * 节点像素半径（**按度数归一**，Obsidian Graph View 语义）。
 *
 * 人物 / 群 / 话题节点不再看 `size`（互动频次），改成「度数越高的节点越大」：
 * 面积 ∝ 度数 → 半径 ∝ `sqrt(degree / maxDegree)`，0 度给最小可见半径 3px。
 *
 * @param degree 节点度数
 * @param maxDegree 当前子图内的最大度数（>0）
 * @returns 像素半径（`[3, 17]`）
 */
export function nodeRadiusByDegree(degree: number, maxDegree: number): number {
  const d = Number.isFinite(degree) ? Math.max(0, degree) : 0;
  const m = Number.isFinite(maxDegree) && maxDegree > 0 ? maxDegree : 1;
  if (d <= 0) return 3;
  const ratio = Math.min(1, d / m);
  return 3 + 14 * Math.sqrt(ratio);
}

/**
 * 按 `degree`（其次 `size`，再其次 `id`）降序挑出参与渲染的节点。
 * 「人」模式按度数取前 N（保留强关系），并保证 `mustKeep`（径向中心「我」）不被截掉。
 *
 * @param nodes 全量画布节点
 * @param maxNodes 上限
 * @param mustKeep 必须保留的节点 id（如「我」）
 * @returns 选中的节点（顺序稳定、可复现）
 */
function selectNodes(
  nodes: readonly GraphPanelNode[],
  maxNodes: number,
  mustKeep?: string,
): GraphPanelNode[] {
  if (nodes.length <= maxNodes) return [...nodes];
  const sorted = [...nodes].sort((a, b) => {
    if (b.degree !== a.degree) return b.degree - a.degree;
    if (b.size !== a.size) return b.size - a.size;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const kept = sorted.slice(0, maxNodes);
  // 若中心节点被截掉，强行补回来（替换掉最后一个非中心节点）
  if (mustKeep !== undefined && !kept.some((node) => node.id === mustKeep)) {
    const center = nodes.find((node) => node.id === mustKeep);
    if (center !== undefined) kept[kept.length - 1] = center;
  }
  return kept;
}

/**
 * 计算力导向布局。
 *
 * @param input 画布尺寸 + 节点 / 边
 * @param options 迭代数 / 向心力 / 内边距 / 节点上限（缺省见各常量）
 * @returns 世界坐标下的节点与线段（`width`/`height` 非法时按 1×1 兜底，绝不产生 NaN）
 */
export function layoutGraph(
  input: GraphLayoutInput,
  options: GraphLayoutOptions = {},
): GraphLayoutResult {
  const width = Number.isFinite(input.width) && input.width > 0 ? input.width : 1;
  const height = Number.isFinite(input.height) && input.height > 0 ? input.height : 1;
  const iterations = Math.max(1, Math.round(options.iterations ?? DEFAULT_ITERATIONS));
  const centerStrength = options.centerStrength ?? 0.02;
  const repulsion = Number.isFinite(options.repulsion) && options.repulsion !== undefined
    ? Math.max(0, options.repulsion)
    : 1;
  const linkStrength = Number.isFinite(options.linkStrength) && options.linkStrength !== undefined
    ? Math.max(0, options.linkStrength)
    : 1;
  const nodeSizeScale = Number.isFinite(options.nodeSizeScale) && options.nodeSizeScale !== undefined
    ? Math.max(0.1, options.nodeSizeScale)
    : 1;
  const maxNodes = Math.max(1, Math.round(options.maxNodes ?? MAX_RENDER_NODES));
  // 边距只用于初始播种，不能再把图钉死在画布边界内。
  const padding = Math.max(0, Math.min(options.padding ?? 28, Math.min(width, height) / 4));

  const selected = selectNodes(input.nodes, maxNodes, options.radialCenterId);
  const droppedNodes = input.nodes.length - selected.length;

  const index = new Map<string, number>();
  selected.forEach((node, i) => index.set(node.id, i));

  const keptEdges: GraphPanelEdge[] = [];
  for (const edge of input.edges) {
    if (index.has(edge.source) && index.has(edge.target)) keptEdges.push(edge);
  }
  const droppedEdges = input.edges.length - keptEdges.length;

  const count = selected.length;
  const requestedLinkDistance = Number.isFinite(options.linkDistance) && options.linkDistance !== undefined
    ? Math.max(1, options.linkDistance)
    : 120;
  // 布局属于可平移世界，而不是当前 canvas 的一个矩形。画布尺寸只影响初始世界跨度；
  // 呈现大小和居中交给 fitViewport，在缩放/拖拽过程中不重算节点坐标。
  // 节点越多，世界面积越大，避免所有节点被迫压进 viewport 的两倍面积。
  const targetSpacing = Math.max(96, requestedLinkDistance * 0.8);
  const densitySide = Math.sqrt(Math.max(1, count)) * targetSpacing;
  const worldWidth = Math.max(960, width * 2, densitySide * 1.35);
  const worldHeight = Math.max(720, height * 2, densitySide * 1.05);
  const cx = worldWidth / 2;
  const cy = worldHeight / 2;

  // 空图：不画任何东西（面板侧另有空态提示，这里只保证形状合法）。
  if (count === 0) {
    return { nodes: [], edges: [], droppedNodes, droppedEdges };
  }

  // 度数归一化用的分母（community 超节点仍按 size=成员数，不用 degree 参与比较）。
  let maxDegree = 0;
  for (const node of selected) {
    if (node.kind !== "community") maxDegree = Math.max(maxDegree, node.degree);
  }
  const collisionGap = Math.max(36, Math.min(64, requestedLinkDistance * 0.35));
  const collisionRadii = selected.map((node) =>
    (node.kind === "community" ? nodeRadius(node.size) : nodeRadiusByDegree(node.degree, maxDegree)) * nodeSizeScale,
  );

  // 径向（确定性环形）模式的中心索引；定义「我」时**不跑力学**，直接按扇区+环摆放。
  const radialIdx = options.radialCenterId !== undefined ? index.get(options.radialCenterId) : undefined;
  const useRadial = radialIdx !== undefined;

  // ① 确定性初始位置：**边权最大的节点放正中心**，其余按「边权」向心（连边越强越靠近枢纽）。
  //    - 把枢纽居中，视觉重心不再偏；
  //    - 强连接节点初始就靠近中心，配合弹簧把它们聚成小簇，减少「一个点拉二十多条长辐条」。
  const weight = new Float64Array(count);
  for (const edge of keptEdges) {
    const a = index.get(edge.source)!;
    const b = index.get(edge.target)!;
    const s = Number.isFinite(edge.strength) ? Math.max(0, edge.strength) : 0;
    weight[a] = weight[a]! + s;
    weight[b] = weight[b]! + s;
  }
  let maxWeight = 0;
  let hubIdx = 0;
  for (let i = 0; i < count; i += 1) {
    if (weight[i]! > maxWeight) {
      maxWeight = weight[i]!;
      hubIdx = i;
    }
  }
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const spread = Math.max(1, Math.min(worldWidth, worldHeight) - 2 * padding);
  for (let i = 0; i < count; i += 1) {
    if (i === hubIdx) {
      xs[i] = cx;
      ys[i] = cy;
      continue;
    }
    const node = selected[i]!;
    const hash = hash32(node.id);
    const angle = hashFraction(hash, 0) * Math.PI * 2;
    const weightRatio = maxWeight > 0 ? Math.min(1, weight[i]! / maxWeight) : 0;
    // 边权越大 → 初始半径越小（越靠近枢纽），形成以枢纽为中心的紧凑簇
    const distance = spread * 0.5 * (0.28 + 0.62 * hashFraction(hash, 1)) * (1 - 0.65 * weightRatio);
    xs[i] = cx + Math.cos(angle) * distance;
    ys[i] = cy + Math.sin(angle) * distance;
  }

  // ② 迭代：斥力 + 弹簧 + 向心，单步位移受温度限制。
  // `k` 是 FR 的理想边长：设置面板的「连距」滑杆直接覆盖它，缺省仍用面积推导值。
  const k = Number.isFinite(options.linkDistance) && options.linkDistance !== undefined
    ? Math.max(1, options.linkDistance)
    : Math.sqrt((worldWidth * worldHeight) / count);
  const t0 = Math.min(worldWidth, worldHeight) * 0.1;
  const dispX = new Float64Array(count);
  const dispY = new Float64Array(count);

  // 径向模式不跑力学（确定性环形，不依赖迭代）
  const frIterations = useRadial ? 0 : iterations;
  for (let step = 0; step < frIterations; step += 1) {
    dispX.fill(0);
    dispY.fill(0);

    // 斥力：任意两点相互推开（O(n²)，n ≤ MAX_RENDER_NODES）
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let dx = xs[i]! - xs[j]!;
        let dy = ys[i]! - ys[j]!;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 0.01) {
          // 完全重合时用确定性微扰拆开（避免除零 → NaN）
          dx = 0.01 * (i + 1);
          dy = 0.01 * (j + 1);
          distance = Math.sqrt(dx * dx + dy * dy);
        }
        // **同社区内斥力衰减**：同 community_key 的节点相互推得更轻 → 聚成小簇，
        // 而不是均匀散成一圈；不同社区之间保持正常斥力，簇与簇彼此分开。
        const ci = selected[i]!.community_key;
        const cj = selected[j]!.community_key;
        const effRepulsion = ci !== null && ci !== undefined && ci === cj ? repulsion * 0.22 : repulsion;
        const force = (effRepulsion * (k * k)) / distance;
        const ux = dx / distance;
        const uy = dy / distance;
        dispX[i] = dispX[i]! + ux * force;
        dispY[i] = dispY[i]! + uy * force;
        dispX[j] = dispX[j]! - ux * force;
        dispY[j] = dispY[j]! - uy * force;

        // 碰撞斥力：节点半径之外再留安全间距，避免高密度图谱成团且标签完全重叠。
        // 与主斥力分开计算，保持连边语义不变；完全重合仍使用上面的确定性微扰。
        const minimumDistance = collisionRadii[i]! + collisionRadii[j]! + collisionGap;
        if (distance < minimumDistance) {
          const overlap = minimumDistance - distance;
          const collisionForce = overlap * (0.8 + 0.2 * Math.min(2, repulsion));
          dispX[i] = dispX[i]! + ux * collisionForce;
          dispY[i] = dispY[i]! + uy * collisionForce;
          dispX[j] = dispX[j]! - ux * collisionForce;
          dispY[j] = dispY[j]! - uy * collisionForce;
        }
      }
    }

    // 弹簧：有边的节点相互拉近
    for (const edge of keptEdges) {
      const a = index.get(edge.source)!;
      const b = index.get(edge.target)!;
      if (a === b) continue;
      let dx = xs[a]! - xs[b]!;
      let dy = ys[a]! - ys[b]!;
      let distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < 0.01) {
        dx = 0.01;
        dy = 0.01;
        distance = Math.sqrt(dx * dx + dy * dy);
      }
      const force = (linkStrength * (distance * distance)) / k;
      const ux = dx / distance;
      const uy = dy / distance;
      dispX[a] = dispX[a]! - ux * force;
      dispY[a] = dispY[a]! - uy * force;
      dispX[b] = dispX[b]! + ux * force;
      dispY[b] = dispY[b]! + uy * force;
    }

    // 向心：把整体收拢到世界原点附近（轻微，避免整体无限漂移）。
    for (let i = 0; i < count; i += 1) {
      dispX[i] = dispX[i]! + (cx - xs[i]!) * centerStrength;
      dispY[i] = dispY[i]! + (cy - ys[i]!) * centerStrength;
    }

    // 降温上限 + 位移应用。坐标不夹到画布边界：用户可平移探索图谱世界。
    const temperature = t0 * (1 - step / iterations) + 0.5;
    for (let i = 0; i < count; i += 1) {
      const dx = dispX[i]!;
      const dy = dispY[i]!;
      const length = Math.sqrt(dx * dx + dy * dy);
      let nextX = xs[i]!;
      let nextY = ys[i]!;
      if (length > 0) {
        const limited = Math.min(length, temperature);
        nextX += (dx / length) * limited;
        nextY += (dy / length) * limited;
      }
      xs[i] = nextX;
      ys[i] = nextY;
    }
  }

  // ②.5 悬挂节点收拢（仅力导向模式）：1 度节点贴到唯一邻居旁，消除边缘散点。
  if (!useRadial) {
    const inducedDeg = new Int32Array(count);
    const lone = new Int32Array(count).fill(-1);
    for (const edge of keptEdges) {
      const a = index.get(edge.source)!;
      const b = index.get(edge.target)!;
      inducedDeg[a] = inducedDeg[a]! + 1;
      inducedDeg[b] = inducedDeg[b]! + 1;
      lone[a] = b;
      lone[b] = a;
    }
    for (let i = 0; i < count; i += 1) {
      if (inducedDeg[i] !== 1 || i === hubIdx) continue;
      const j = lone[i]!;
      if (j < 0) continue;
      const angle = hashFraction(hash32(selected[i]!.id), 0) * Math.PI * 2;
      const ring = 16 + nodeRadius(selected[i]!.size);
      xs[i] = xs[j]! + Math.cos(angle) * ring;
      ys[i] = ys[j]! + Math.sin(angle) * ring;
    }
  }

  // ②.6 径向「日晷/扇形」布局（「仅与我直接关系」模式）：**不跑力学**；中心「我」钉在世界中心，
  //      邻居按社区分扇区（扇区之间留 gap），扇区内按**节点度数**从内环到外环扇形铺开
  //      （度数高的靠近内环）。结果保留为世界坐标，后面不做归一化。
  if (useRadial && radialIdx !== undefined) {
    xs[radialIdx] = cx;
    ys[radialIdx] = cy;
    const byCommunity = new Map<string | null, number[]>();
    for (let i = 0; i < count; i += 1) {
      if (i === radialIdx) continue;
      const key = selected[i]!.community_key ?? null;
      const arr = byCommunity.get(key) ?? [];
      arr.push(i);
      byCommunity.set(key, arr);
    }
    const sectors = [...byCommunity.values()].sort((a, b) => b.length - a.length);
    const total = Math.max(1, count - 1);
    const maxR = Math.min(worldWidth, worldHeight) * 0.42;
    const innerR = maxR * 0.42;
    const outerR = maxR;
    const gap = sectors.length > 1 ? Math.min(0.05, (Math.PI * 0.5) / sectors.length) : 0;
    const usable = Math.PI * 2 - gap * sectors.length;
    let theta = -Math.PI / 2;
    for (const members of sectors) {
      const sectorWidth = (members.length / total) * usable;
      const start = theta + gap / 2;
      theta += sectorWidth + gap;
      members.sort((a, b) => {
        const da = selected[a]!.degree;
        const db = selected[b]!.degree;
        if (db !== da) return db - da;
        return selected[a]!.id < selected[b]!.id ? -1 : 1;
      });
      const m = members.length;
      members.forEach((idx, k) => {
        const frac = m > 1 ? (k + 0.5) / m : 0.5;
        const angle = start + sectorWidth * frac;
        const degRank = m > 1 ? k / (m - 1) : 0; // 0 = 度数最高 → 最内环
        const r = innerR + (outerR - innerR) * degRank;
        xs[idx] = cx + Math.cos(angle) * r;
        ys[idx] = cy + Math.sin(angle) * r;
      });
    }
  }

  const layoutNodes: GraphLayoutNode[] = selected.map((node, i) => {
    const x = xs[i]!;
    const y = ys[i]!;
    const baseRadius =
      node.kind === "community"
        ? nodeRadius(node.size)
        : nodeRadiusByDegree(node.degree, maxDegree);
    const prominence =
      node.kind === "community" ? Math.min(1, Math.max(0, node.size)) : maxDegree > 0 ? node.degree / maxDegree : 0;
    return {
      id: node.id,
      label: node.label,
      kind: node.kind,
      x,
      y,
      radius: baseRadius * nodeSizeScale,
      isolated: node.isolated,
      degree: node.degree,
      communityKey: node.community_key,
      prominence,
    };
  });

  const layoutEdges: GraphLayoutEdge[] = keptEdges.map((edge) => {
    const a = layoutNodes[index.get(edge.source)!]!;
    const b = layoutNodes[index.get(edge.target)!]!;
    return {
      id: edge.id,
      kind: edge.kind,
      strength: edge.strength,
      source: edge.source,
      target: edge.target,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
    };
  });

  return { nodes: layoutNodes, edges: layoutEdges, droppedNodes, droppedEdges };
}
