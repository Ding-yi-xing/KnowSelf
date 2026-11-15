/**
 * 能力抽取引擎（T03）：`profile.sqlite` 的 cards / card_sections → 能力图谱快照。
 *
 * ## 口径（与架构案的一处有意偏差，已由 team-lead 定稿）
 * 架构案是「能力项 = 归一化 section.title ∩ 白名单」，在**真实数据上不成立**：
 * 真实标题全是通用词（技能 / 技能清单 / 专业技能 / 技术栈 / skills），
 * 照标题抽只会得到 3~4 个同义节点，而 `Java` / `Spring Boot` / `MySQL` 一个都不会出现。
 *
 * 本实现的正确口径：
 *   - **能力项从 `section.body` 抽**；
 *   - `section.title` 只用于两件事：**要不要抽**（`stopwords.ts`）、**归到哪一类**；
 *   - body 按「类别：项、项、项」切分 → 同一类别分组内连边（**不做同 section 全连**，
 *     那样「技能清单」20 项会产出 190 条边的毛球）。
 *
 * ## 四条硬规则（都是真实数据踩出来的，不是假设）
 * 1. **`/` 不是分隔符**：`MyBatis/MyBatis-Plus` 必须是一项；
 * 2. **同一 body 只算一份证据**：真实库里有三份 ≈201 字、内容近逐字相同的小节，
 *    不去重的话 `Java–Spring Boot` 的边权会变成 3（虚假强度）；
 * 3. **比较用小写 key，展示保留首次原样**：`python` 与 `Python` 合为一个节点，
 *    label 取先出现的那个写法；
 * 4. **只在同一「类别：」分组内连边**：跨组不连，避免技能清单式的全连通毛球。
 *
 * 纯函数式：无 I/O、无 LLM、时间可注入（`now`），同输入必得同输出。
 */
import { createHash } from "node:crypto";
import {
  AbilitySnapshotSchema,
  type AbilityEdge,
  type AbilityNode,
  type AbilitySnapshot,
  type CardSectionStored,
  type CardSummary,
  type CardWithSections,
} from "@knowself/contracts";
import { isStopwordGroup, isStopwordTitle } from "./stopwords.js";

/** 快照口径版本（契约 `graph_version`，改抽取规则时递增）。 */
export const ABILITY_GRAPH_VERSION = "ability-graph-v1";
/** 产出者标识（写进快照，便于区分规则版与将来的 LLM 版）。 */
export const ABILITY_PRODUCED_BY = "knowself:ability-rule-v1";

/** 命中「类别：」结构的置信度。 */
const CONFIDENCE_STRUCTURED = 0.9;
/** 纯顿号列表的置信度。 */
const CONFIDENCE_FLAT = 0.7;

/** 单个能力项的最大长度（超过即视为散文，不是能力名）。 */
const MAX_ITEM_CHARS = 20;
/** 组名最大长度（`类别：` 左边超长基本是散文冒号，不是分组）。 */
const MAX_GROUP_CHARS = 12;
/** 证据串里 body 摘要长度。 */
const EVIDENCE_SNIPPET_CHARS = 80;
/** 每节点/每边证据上限（契约 `.max(5)`）。 */
const MAX_EVIDENCE = 5;

/** card_key → 能力分类。未列出的卡归 `other`。 */
const CARD_CATEGORY: Readonly<Record<string, string>> = {
  skills: "tech",
  soft_skills: "soft",
};

/**
 * 叙事型小节：**只做边证据、不做节点来源**（T06）。
 *
 * - `projects` 卡的全部小节（真实标题是「主要项目 / 项目经历 / projects」，已在停用表里 ——
 *   做节点会产出「实现智能问答」「港口场景目标检测与越界识别」这类叙事碎片，是垃圾）；
 * - `skills` 卡里的「项目经历」「实习经历」两节（同样的叙事形态）。
 *
 * 但它们的正文恰恰是**能力关联最强的证据**：`技术栈Java 21、Spring Boot3、PostgreSQL、
 * pgvector、Redis、Vue3` —— 同一个项目里真实共用的技术。停用节点 ≠ 丢弃证据。
 */
const PROJECT_EVIDENCE_CARD = "projects";
const PROJECT_EVIDENCE_SECTIONS: ReadonlySet<string> = new Set(
  ["主要项目", "项目经历", "projects", "实习经历", "职业经历"].map((title) =>
    normalizeTitleForMatch(title),
  ),
);

/**
 * 该节是否属于「叙事型边证据」。
 *
 * 判定与卡无关（`projects` 卡整卡收录 + 任意卡里标题命中的叙事节），因为同一叙事
 * 在真实库里会散落在多张卡：`skills` 有「项目经历/实习经历」、`experience` 有「实习经历」、
 * `internship` 有「职业经历」。
 *
 * @param cardKey 所属卡
 * @param title 节标题
 */
function isProjectEvidenceSection(cardKey: string, title: string): boolean {
  if (cardKey === PROJECT_EVIDENCE_CARD) return true;
  return PROJECT_EVIDENCE_SECTIONS.has(normalizeTitleForMatch(title));
}

/**
 * 把叙事节正文切成**项目级**片段（0.5.0 T06 修订）。
 *
 * ## 为什么必须切
 * 真实 `项目经历` 一节里写了 4 个项目。按「整节一个 body」计权时，`YOLO ↔ Spring Boot`
 * 会得到 weight=4 —— 但 Spring Boot 出现在项目 1/2、YOLO 只出现在项目 4，
 * 这是一条**假关系**。这个视图的全部价值就是「关系可信」，一条假边比少一条边伤害大得多
 * （与「宁可空也不兜底垃圾节点」同一条原则）。
 *
 * ## 切法
 * 识别行文里的序号标记 `1.` / `2、` / `3)`（要求标记前是行首或空白，避免误切 `2026.03` 这类日期）；
 * 只有在**从 1 开始且递增**时才认为是项目编号，否则整节当一个项目（不猜）。
 *
 * @param body 叙事节正文
 * @returns 项目级片段（去空白后非空的）
 */
export function splitProjects(body: string): string[] {
  // 标记前可以是行首/空白，也可以是句末标点（真实文本里常见 `…开发。2. 基于…`，中间没有空格）；
  // `(?!\\d)` 防止把 `3.5 年`、`2026.03` 这类版本号/日期误当编号。
  // 标记必须落在**句子边界**：行首 / `。` / `；` / 换行。为什么不能用任意空白 ——
  // 真实正文里有 `Spring Boot 3、PostgreSQL`：若允许「空白 + 数字 + 顿号」当编号，
  // 这个 "3" 会被误认成第 3 个项目，序列变成 1,3,2,3,4 → 判为「非连续编号」→
  // 整节退化成"一个项目"，`YOLO ↔ Spring Boot` 的假关系就会复活（实测踩过）。
  // 标点只认 `.` / `．` / `)`：顿号在中文里几乎总是列表项，不是项目编号。
  const marker = /(?:^|[。；;\n])\s*(\d{1,2})[.．)](?!\d)\s*/gu;
  const hits: { index: number; end: number; num: number }[] = [];
  for (const match of body.matchAll(marker)) {
    const num = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(num)) continue;
    const index = match.index ?? 0;
    hits.push({ index, end: index + match[0].length, num });
  }

  // 必须从 1 开始且逐个递增（`1. 2. 4.` 这种缺号 → 不认为可信分块，整体当一个项目）
  let sequential = hits.length > 1 && (hits[0] as { num: number }).num === 1;
  if (sequential) {
    for (let i = 1; i < hits.length; i += 1) {
      if ((hits[i] as { num: number }).num !== (hits[i - 1] as { num: number }).num + 1) {
        sequential = false;
        break;
      }
    }
  }
  if (!sequential) {
    const whole = body.trim();
    return whole === "" ? [] : [whole];
  }

  const chunks: string[] = [];
  for (let i = 0; i < hits.length; i += 1) {
    const current = hits[i] as { index: number; end: number };
    const next = hits[i + 1] as { index: number } | undefined;
    const end = next === undefined ? body.length : next.index;
    const text = body.slice(current.end, end).trim();
    if (text !== "") chunks.push(text);
  }
  return chunks;
}

/** 归一化（仅用于标题集合比较）：NFKC + 去空白标点。 */
function normalizeTitleForMatch(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 在正文里查找**已存在节点**的出现位置（T06 `co_project` 用）。
 *
 * 为什么需要边界守卫：`Java` 会命中 `JavaWeb`、`Git` 会命中 `GitHub`，
 * 那会把「证书名/平台名」误当成项目里的技术共现。规则：
 *   - label 以字母/数字开头 → 前面不得是字母/数字；
 *   - label 以字母/数字结尾 → 后面不得是**字母**（允许数字，`Spring Boot` 要能命中 `Spring Boot3`）。
 * 中文 label 两边不加守卫（中文没有词边界，且不会与英文粘连产生误判）。
 */
function labelAppearsInText(label: string, text: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = /^[A-Za-z0-9]/.test(label) ? "(?<![A-Za-z0-9])" : "";
  const tail = /[A-Za-z0-9]$/.test(label) ? "(?![A-Za-z])" : "";
  return new RegExp(`${head}${escaped}${tail}`, "iu").test(text);
}

/** 分类展示优先级（多卡命中时取最具体的一类）。 */
const CATEGORY_RANK: Readonly<Record<string, number>> = { tech: 0, soft: 1, other: 2 };

/**
 * 抽取所需的**最小** store 能力面（`ProfileStore` 结构满足）。
 * 刻意不依赖 `ProfileStore` 具体实现，测试可直接给内存桩。
 */
export interface AbilityStoreLike {
  cards: {
    list(): CardSummary[];
    get(key: string): CardWithSections;
  };
}

/** 抽取依赖（`now` / `fingerprint` 均由调用方提供，便于测试确定性）。 */
export interface ExtractDeps {
  store: AbilityStoreLike;
  /** 快照指纹（`cache.ts` 计算后传入，避免重复扫库）。 */
  fingerprint: string;
  /** 生成时间（ISO8601 带偏移）；缺省当前时间。 */
  now?: string;
}

/** 展示用归一化：去首尾空白（含全角空格）、去句末标点、压内部空白；保留大小写。 */
export function normalizeItem(raw: string): string {
  return raw
    .replace(/[\u3000\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.，,、;；:：!！]+$/u, "")
    .trim();
}

/** 比较用 key：展示归一化后再小写（`Python` → `python`）。 */
export function itemKey(raw: string): string {
  return normalizeItem(raw).toLowerCase();
}

/** sha1 十六进制。 */
export function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf-8").digest("hex");
}

/** body 指纹（去重「近似重复资料」用）：按归一化后的全文算。 */
export function bodyFingerprint(body: string): string {
  return sha1Hex(body.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase());
}

/** 一个分组的解析结果。 */
export interface ParsedGroup {
  /** 「类别：」左边那段；纯列表为 null。 */
  group: string | null;
  /** 组内能力项（展示原样，未去重）。 */
  items: string[];
  /** 是否命中「类别：」结构（决定 confidence）。 */
  structured: boolean;
}

/**
 * 把一段文本切成能力项。
 *
 * 分隔符：`、` `，` `,` `;` `；`（**不含 `/`**）。过滤规则：
 *   - 展示归一化后为空 → 丢；
 *   - 长度 > `MAX_ITEM_CHARS` → 丢（散文片段不是能力名）；
 *   - 不含任何字母/汉字（纯数字/符号）→ 丢。
 */
export function splitItems(raw: string): string[] {
  const parts = raw.split(/[、，,;；]/u);
  const items: string[] = [];
  for (const part of parts) {
    const item = normalizeItem(part);
    if (item === "") continue;
    if ([...item].length > MAX_ITEM_CHARS) continue;
    if (!/\p{L}/u.test(item)) continue;
    items.push(item);
  }
  return items;
}

/**
 * 解析一段 body → 若干分组。
 *
 * ## 为什么要按「任意位置的 `X：`」切，而不是按行切
 * 真实数据两种写法并存：
 *   - `专业技能` / `技术栈`：`后端开发：…\n数据库：…`（换行分隔）；
 *   - `技能清单`（248 字）：`后端：…MQTT 数据库：MySQL…` —— **同一行里用空格接下一个分组**。
 * 只按行切会把 `MQTT 数据库：MySQL` 当成一个能力项（首版 golden 里确实出现了这条垃圾），
 * 所以这里改用「扫描所有 `X：` 分组长」的方式，换行与空格都自然成为边界。
 *
 * `X` 的约束（1~12 个字、且必须含字母/汉字）：`10:30`、`2024.12-2025.08` 这类不会被误当分组。
 * **`/` 从不出现在分隔符里**（`MyBatis/MyBatis-Plus` 保持一项）。
 */
export function parseBody(body: string, category?: string): ParsedGroup[] {
  const out: ParsedGroup[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/[\u3000\u00a0]/g, " ").replace(/\s+/g, " ").trim();
    if (line === "") continue;

    for (const chunk of splitLineIntoChunks(line)) {
      if (chunk.group !== null && isStopwordGroup(chunk.group)) continue;

      let items = splitItems(chunk.body);
      if (chunk.group !== null) {
        if (items.length === 0) {
          items = [chunk.group];
        } else if (category === "soft") {
          // 软技能的 body 是散文（`团队领导力：曾担任6人项目团队负责人，协调客户端…`），
          // 切成项只会得到「协调客户端」「曾担任6人项目团队负责人」这类句子碎片；
          // 而「团队领导力」本身才是能力。所以软技能一律取分组名。
          items = [chunk.group];
        }
      }
      if (items.length === 0) continue;
      out.push({ group: chunk.group, items, structured: chunk.group !== null });
    }
  }
  return out;
}

/** 行内切片结果：`X：` 分组头 + 其后的正文（到下一个分组头为止）。 */
interface LineChunk {
  group: string | null;
  body: string;
}

/** 分组头匹配：1~12 个非空白非分隔符字符 + 冒号（半角/全角）。 */
const GROUP_HEADER = /[^\s：:、，,；;。]{1,12}[：:]/gu;

/**
 * 把一行切成若干「分组块」。
 *
 * 无分组头的整行 → 单块（`group=null`）。
 */
export function splitLineIntoChunks(line: string): LineChunk[] {
  const starts: { index: number; end: number; group: string }[] = [];
  for (const match of line.matchAll(GROUP_HEADER)) {
    const raw = match[0];
    const name = normalizeItem(raw.slice(0, -1));
    if (name === "") continue;
    if ([...name].length > MAX_GROUP_CHARS) continue;
    if (!/\p{L}/u.test(name)) continue; // 排除 `10:30` 这类
    const index = match.index ?? 0;
    starts.push({ index, end: index + raw.length, group: name });
  }

  if (starts.length === 0) return [{ group: null, body: line }];

  const chunks: LineChunk[] = [];
  const first = starts[0] as { index: number };
  if (first.index > 0) {
    // 分组头之前还有正文（如「主要技能：…」之前的前缀句）→ 按纯列表块处理
    chunks.push({ group: null, body: line.slice(0, first.index) });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i] as { index: number; end: number; group: string };
    const next = starts[i + 1] as { index: number } | undefined;
    const end = next === undefined ? line.length : next.index;
    chunks.push({ group: current.group, body: line.slice(current.end, end) });
  }
  return chunks;
}

/** 由能力项 key 生成稳定节点 id（`ability:<sha1(key)>`）。 */
export function abilityNodeIdFromKey(key: string): string {
  return `ability:${sha1Hex(key)}`;
}

/** 由展示名生成稳定节点 id。 */
export function abilityNodeId(label: string): string {
  return abilityNodeIdFromKey(itemKey(label));
}

/**
 * 无序对 id：`<kind>:<较小 node id>|<较大 node id>`（与 GraphPanelEdge 的 id 约定一致）。
 *
 * @param kind 边类型（默认 `co_section`，保持既有调用不变）
 * @param a 端点 A
 * @param b 端点 B
 */
export function abilityEdgeId(kind: AbilityEdge["kind"], a: string, b: string): string {
  const [first, second] = a <= b ? [a, b] : [b, a];
  return `${kind}:${first}|${second}`;
}

/** 证据串：`<card_key>#<section_id> 《<title>》: <body 前 80 字>`。 */
export function evidenceRef(section: CardSectionStored): string {
  const snippet = section.body.replace(/\s+/g, " ").trim().slice(0, EVIDENCE_SNIPPET_CHARS);
  return `${section.card_key}#${section.id} 《${section.title}》: ${snippet}`;
}

/** 截断到 ≤ n 个字符（按码点，避免切坏 emoji/中文）。 */
function capChars(text: string, n: number): string {
  const chars = [...text];
  return chars.length <= n ? text : chars.slice(0, n).join("");
}

/** 节点累加器。 */
interface NodeAcc {
  label: string;
  cardKeys: Set<string>;
  groups: Set<string>;
  evidence: string[];
  confidence: number;
}

/** 边累加器。 */
interface EdgeAcc {
  source: string;
  target: string;
  kind: AbilityEdge["kind"];
  weight: number;
  evidence: string[];
  /** 已计入权重的 body 指纹（同一份资料不得重复加权）。 */
  bodies: Set<string>;
}

/**
 * 计算快照指纹：**必须**包含 `sections.body`。
 *
 * 只 hash `updated_at` 不够 —— 真实库里存在「卡没动、只改了某一节正文」的写入路径，
 * 那种变更在 `cards.updated_at` 上看不出来，会命中陈旧缓存（T03 明确要求）。
 *
 * @param store 数据源
 * @returns 40 位 sha1
 */
export function computeAbilityFingerprint(store: AbilityStoreLike): string {
  const cards = [...store.cards.list()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const parts: string[] = [];
  for (const summary of cards) {
    parts.push(`card:${summary.key}|${summary.updated_at}`);
    const detail = store.cards.get(summary.key);
    for (const section of [...detail.sections].sort((a, b) => a.id - b.id)) {
      parts.push(`section:${section.id}|${section.title}|${section.body}`);
    }
  }
  return sha1Hex(parts.join("\u0000"));
}

/**
 * 项目级切分（对外 API，T06 定稿）。
 *
 * @param section 叙事型小节
 * @returns 项目体列表；无编号标记时整体一段（不因无编号而丢边）
 */
export function splitProjectBodies(section: CardSectionStored): string[] {
  return splitProjects(section.body);
}

/**
 * 抽取能力快照。
 *
 * @param deps store + 指纹（+ 可选 now）
 * @returns 通过 `AbilitySnapshotSchema` 校验的快照（节点按度数降序、边按权重降序）
 * @throws ZodError 抽取结果违反契约（属编程错误，不该被静默吞掉）
 */
export function extractAbilitySnapshot(deps: ExtractDeps): AbilitySnapshot {
  const { store } = deps;
  const nodes = new Map<string, NodeAcc>();
  const edges = new Map<string, EdgeAcc>();
  /** body 指纹已见集合：同一份资料只算一份证据。 */
  const seenBodies = new Set<string>();
  /** 叙事型小节（只做 `co_project` 边证据，不做节点）。 */
  const projectSections: CardSectionStored[] = [];
  const usedCards = new Set<string>();
  let sourceCount = 0;

  const summaries = [...store.cards.list()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  for (const summary of summaries) {
    const detail = store.cards.get(summary.key);
    // 分类只看卡（cards.key），不看节标题 —— 节标题是通用词（技能/技术栈），没有区分度。
    const cardCategory = CARD_CATEGORY[summary.key] ?? "other";
    for (const section of [...detail.sections].sort((a, b) => a.id - b.id)) {
      if (section.body.trim() === "") continue;

      // T06：叙事型小节先登记为**边证据**，再按停用表跳过（停用节点 ≠ 丢弃证据）。
      if (isProjectEvidenceSection(summary.key, section.title)) {
        projectSections.push(section);
      }

      if (isStopwordTitle(section.title)) continue;

      const bodyHash = bodyFingerprint(section.body);
      if (seenBodies.has(bodyHash)) continue; // 规则 2
      seenBodies.add(bodyHash);

      const evidence = evidenceRef(section);
      let contributed = false;

      for (const group of parseBody(section.body, cardCategory)) {
        const ids: string[] = [];
        for (const item of group.items) {
          const key = itemKey(item);
          if (key === "") continue;
          const nodeId = abilityNodeIdFromKey(key);
          const acc = nodes.get(nodeId);
          if (acc === undefined) {
            nodes.set(nodeId, {
              label: item,
              cardKeys: new Set([summary.key]),
              groups: new Set(group.group === null ? [] : [group.group]),
              evidence: [evidence],
              confidence: group.structured ? CONFIDENCE_STRUCTURED : CONFIDENCE_FLAT,
            });
          } else {
            acc.cardKeys.add(summary.key);
            if (group.group !== null) acc.groups.add(group.group);
            if (acc.evidence.length < MAX_EVIDENCE && !acc.evidence.includes(evidence)) {
              acc.evidence.push(evidence);
            }
            acc.confidence = Math.max(
              acc.confidence,
              group.structured ? CONFIDENCE_STRUCTURED : CONFIDENCE_FLAT,
            );
          }
          if (!ids.includes(nodeId)) ids.push(nodeId);
          contributed = true;
        }

        // 规则 4：只在同一「类别：」分组内连边
        if (ids.length < 2) continue;
        for (let i = 0; i < ids.length; i += 1) {
          for (let j = i + 1; j < ids.length; j += 1) {
            const a = ids[i] as string;
            const b = ids[j] as string;
            const id = abilityEdgeId("co_section", a, b);
            let acc = edges.get(id);
            if (acc === undefined) {
              acc = { source: a, target: b, kind: "co_section", weight: 0, evidence: [], bodies: new Set() };
              edges.set(id, acc);
            }
            if (!acc.bodies.has(bodyHash)) {
              acc.bodies.add(bodyHash);
              acc.weight += 1;
            }
            if (acc.evidence.length < MAX_EVIDENCE && !acc.evidence.includes(evidence)) {
              acc.evidence.push(evidence);
            }
          }
        }
      }

      if (contributed) {
        usedCards.add(summary.key);
        sourceCount += 1;
      }
    }
  }

  /** 节点 id → { label, group }（`co_project` 匹配与跨组判定用）。 */
  const nodeMeta = [...nodes.entries()].map(([id, acc]) => ({
    id,
    label: acc.label,
    group: [...acc.groups][0] ?? null,
    cardKeys: acc.cardKeys,
  }));

  // ── same_card（0.5.0 T03 裁决①）：**仅 soft_skills 卡内** ──────────────────
  // 为什么只限软技能卡：soft_skills 每组只有 1 项（组名），产不出 co_section 边，
  // 3 个节点会变成图上的游离点（用户会当成渲染 bug）。skills 卡有 24 点，
  // 全连是 276 条边的毛球 —— 这条红线不放松。
  const softIds = nodeMeta
    .filter((meta) => meta.cardKeys.has("soft_skills"))
    .map((meta) => meta.id)
    .sort();
  for (let i = 0; i < softIds.length; i += 1) {
    for (let j = i + 1; j < softIds.length; j += 1) {
      const a = softIds[i] as string;
      const b = softIds[j] as string;
      const id = abilityEdgeId("same_card", a, b);
      const acc = edges.get(id);
      if (acc !== undefined) continue;
      edges.set(id, {
        source: a,
        target: b,
        kind: "same_card",
        weight: 1,
        evidence: [],
        bodies: new Set(),
      });
    }
  }

  // ── co_project（0.5.0 T06）：跨簇桥边 ──────────────────────────────────────
  // 只连**已存在的节点**（不在节点集里的 TypeScript / pgvector / BGE-M3 等一律不新增节点），
  // 且只在两个节点属于**不同 group** 时生成（同组 pair 已由 co_section 覆盖）。
  const projectSeen = new Set<string>();
  for (const section of projectSections) {
    // 项目级切分（T06 定稿）：weight 的含义从「几节共现」变成「几个项目里同时用过」。
    for (const projectText of splitProjectBodies(section)) {
      const bodyHash = bodyFingerprint(projectText);
      if (projectSeen.has(bodyHash)) continue; // 同一份叙事只算一次
      projectSeen.add(bodyHash);

      const evidence = evidenceRef(section);
      const hitIds = nodeMeta
        .filter((meta) => labelAppearsInText(meta.label, projectText))
        .map((meta) => meta.id)
        .sort();

      for (let i = 0; i < hitIds.length; i += 1) {
        for (let j = i + 1; j < hitIds.length; j += 1) {
          const a = hitIds[i] as string;
          const b = hitIds[j] as string;
          const groupA = nodeMeta.find((meta) => meta.id === a)?.group ?? null;
          const groupB = nodeMeta.find((meta) => meta.id === b)?.group ?? null;
          // 同组 pair 跳过（已有 co_section，重复计数会让权重失真）
          if (groupA !== null && groupB !== null && groupA === groupB) continue;
          // 该 pair 已有 co_section 边 → 不再生成 co_project
          if (edges.has(abilityEdgeId("co_section", a, b))) continue;

          const id = abilityEdgeId("co_project", a, b);
          let acc = edges.get(id);
          if (acc === undefined) {
            acc = { source: a, target: b, kind: "co_project", weight: 0, evidence: [], bodies: new Set() };
            edges.set(id, acc);
          }
          if (!acc.bodies.has(bodyHash)) {
            acc.bodies.add(bodyHash);
            acc.weight += 1;
          }
          if (acc.evidence.length < MAX_EVIDENCE && !acc.evidence.includes(evidence)) {
            acc.evidence.push(evidence);
          }
        }
      }
    }
  }

  // 度数
  const degree = new Map<string, number>();
  for (const acc of edges.values()) {
    degree.set(acc.source, (degree.get(acc.source) ?? 0) + 1);
    degree.set(acc.target, (degree.get(acc.target) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, ...degree.values());
  const maxWeight = Math.max(1, ...[...edges.values()].map((acc) => acc.weight));

  const nodeList: AbilityNode[] = [];
  for (const [nodeId, acc] of nodes) {
    const deg = degree.get(nodeId) ?? 0;
    const cardKeys = [...acc.cardKeys].sort();
    const category =
      cardKeys
        .map((cardKey) => CARD_CATEGORY[cardKey] ?? "other")
        .sort((a, b) => (CATEGORY_RANK[a] ?? 9) - (CATEGORY_RANK[b] ?? 9))[0] ?? null;
    nodeList.push({
      id: nodeId,
      label: capChars(acc.label, 128),
      category,
      size: Math.min(1, deg / maxDegree),
      degree: deg,
      community_key: null,
      confidence: acc.confidence,
      attrs: {
        card_keys: cardKeys.slice(0, 32),
        group: [...acc.groups][0] ?? null,
        evidence_ref: acc.evidence.slice(0, MAX_EVIDENCE),
      },
    });
  }
  nodeList.sort((a, b) => b.degree - a.degree || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const edgeList: AbilityEdge[] = [];
  for (const [id, acc] of edges) {
    edgeList.push({
      id,
      source: acc.source,
      target: acc.target,
      kind: acc.kind,
      weight_raw: acc.weight,
      strength: Math.min(1, acc.weight / maxWeight),
      directed: false,
      attrs: { evidence_ref: acc.evidence.slice(0, MAX_EVIDENCE) },
    });
  }
  edgeList.sort((a, b) => b.weight_raw - a.weight_raw || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return AbilitySnapshotSchema.parse({
    graph_version: ABILITY_GRAPH_VERSION,
    produced_by: ABILITY_PRODUCED_BY,
    generated_at: deps.now ?? new Date().toISOString(),
    fingerprint: deps.fingerprint,
    stats: {
      node_count: nodeList.length,
      edge_count: edgeList.length,
      card_count: usedCards.size,
      source_count: sourceCount,
    },
    nodes: nodeList,
    edges: edgeList,
  });
}
