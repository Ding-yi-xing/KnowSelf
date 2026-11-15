/**
 * T03：能力抽取的**规则回归锁**。
 *
 * 每条用例都对应一处**真实数据**踩出来的坑（不是想象的边界）：
 *   ① `MyBatis/MyBatis-Plus` 是一个能力项 —— `/` 不能当分隔符；
 *   ② `python` 与 `Python` 是一个节点 —— 比较用小写 key，展示保留首次原样；
 *   ③ 三份近似重复的 201 字 body 只算**一份证据** —— 否则 Java–Spring Boot 边权虚高成 3；
 *   ④ 停用表要挡掉「荣誉奖项」这类档案节 —— `一等奖` 不是能力项；
 *   ⑤ 只在同一「类别：」分组内连边 —— 否则「技能清单」20 项会连成 190 条边的毛球；
 *   ⑥ 同一行里用空格接下一个分组（`…MQTT 数据库：MySQL…`）不能并成一项。
 */
import { describe, expect, it } from "vitest";
import {
  abilityNodeId,
  bodyFingerprint,
  computeAbilityFingerprint,
  extractAbilitySnapshot,
  parseBody,
  splitItems,
  splitProjects,
  type AbilityStoreLike,
} from "../src/ability/extract.js";
import { isStopwordGroup, isStopwordTitle } from "../src/ability/stopwords.js";
import { AbilityEdgeKindSchema } from "@knowself/contracts";

/** 构造 section（id 顺序即插入顺序）。 */
function section(id: number, title: string, body: string) {
  return { id, card_key: "skills", title, body, ord: id, updated_at: "2026-11-01T00:00:00+08:00" };
}

/** 构造最小 store 桩（结构满足 `AbilityStoreLike`）。 */
function makeStore(
  cards: { key: string; sections: ReturnType<typeof section>[] }[],
): AbilityStoreLike {
  const details = new Map(
    cards.map((card) => [
      card.key,
      {
        card: {
          key: card.key,
          title: card.key,
          summary: "",
          section_tags: [],
          updated_at: "2026-11-01T00:00:00+08:00",
          schema_version: 1 as const,
        },
        sections: card.sections,
      },
    ]),
  );
  return {
    cards: {
      list: () =>
        cards.map((card) => ({
          key: card.key,
          title: card.key,
          summary: "",
          section_tags: [],
          updated_at: "2026-11-01T00:00:00+08:00",
        })) as never,
      get: (key: string) => details.get(key) as never,
    },
  };
}

/** 跑一次抽取（指纹现算，时间固定以便快照可比）。 */
function run(store: AbilityStoreLike) {
  return extractAbilitySnapshot({
    store,
    fingerprint: computeAbilityFingerprint(store),
    now: "2026-11-13T14:00:00+08:00",
  });
}

const labels = (snapshot: ReturnType<typeof run>): string[] => snapshot.nodes.map((n) => n.label);

describe("能力抽取 · 规则回归", () => {
  it("① `MyBatis/MyBatis-Plus` 是一项：`/` 不是分隔符", () => {
    const store = makeStore([
      { key: "skills", sections: [section(1, "技能清单", "后端：Java、MyBatis/MyBatis-Plus、Spring Boot")] },
    ]);
    const snapshot = run(store);
    expect(labels(snapshot)).toContain("MyBatis/MyBatis-Plus");
    // 不得被切成两个独立节点
    expect(labels(snapshot)).not.toContain("MyBatis");
    expect(labels(snapshot)).not.toContain("MyBatis-Plus");
    expect(splitItems("MyBatis/MyBatis-Plus")).toEqual(["MyBatis/MyBatis-Plus"]);
  });

  it("② `python` 与 `Python` 合并为一个节点，label 取首次出现的写法", () => {
    const store = makeStore([
      {
        key: "skills",
        sections: [
          section(1, "技能", "语言：Python、Java"),
          section(2, "技能清单", "语言：python、Rust"),
        ],
      },
    ]);
    const snapshot = run(store);
    const pythons = snapshot.nodes.filter((n) => n.label.toLowerCase() === "python");
    expect(pythons).toHaveLength(1);
    expect(pythons[0]?.label).toBe("Python");
    // 两节都提到 → 合并后仍是一个节点，且带两份证据
    expect(pythons[0]?.attrs.evidence_ref.length).toBe(2);
  });

  it("③ 三份近似重复 body 只算一份证据（边权不得虚高）", () => {
    const bodyWithNewline = "后端：Java、Spring Boot\n数据库：MySQL、Redis";
    const bodyWithSpace = "后端：Java、Spring Boot 数据库：MySQL、Redis";
    const store = makeStore([
      {
        key: "skills",
        sections: [
          section(1, "专业技能", bodyWithNewline),
          section(2, "技术栈", bodyWithNewline),
          section(3, "skills", bodyWithSpace),
        ],
      },
    ]);
    // 三份 body 归一化后指纹相同
    const hashes = new Set([bodyFingerprint(bodyWithNewline), bodyFingerprint(bodyWithSpace)]);
    expect(hashes.size).toBe(1);

    const snapshot = run(store);
    expect(snapshot.stats.source_count).toBe(1); // 只承认一份资料
    const edge = snapshot.edges.find(
      (e) => e.source === abilityNodeId("Java") && e.target === abilityNodeId("Spring Boot"),
    );
    expect(edge?.weight_raw).toBe(1); // 不是 3
  });

  it("④ 停用表排除「荣誉奖项」：`一等奖` 不成为能力节点", () => {
    expect(isStopwordTitle("荣誉奖项")).toBe(true);
    expect(isStopwordTitle("获奖记录")).toBe(true);
    expect(isStopwordTitle("基本信息")).toBe(true);
    expect(isStopwordTitle("123")).toBe(true);
    expect(isStopwordTitle("技能清单")).toBe(false);

    const store = makeStore([
      {
        key: "skills",
        sections: [
          section(1, "荣誉奖项", "国家级：一等奖、二等奖\n省级：一等奖"),
          section(2, "技能", "后端：Java、MySQL"),
        ],
      },
    ]);
    const snapshot = run(store);
    expect(labels(snapshot)).not.toContain("一等奖");
    expect(labels(snapshot)).not.toContain("二等奖");
    expect(labels(snapshot)).toEqual(expect.arrayContaining(["Java", "MySQL"]));
  });

  it("⑤ 只在同一「类别：」分组内连边，不产生跨组全连通", () => {
    const store = makeStore([
      {
        key: "skills",
        sections: [section(1, "专业技能", "后端：A、B、C\n数据库：D、E")],
      },
    ]);
    const snapshot = run(store);
    // 组内全连：C(3,2)=3 + C(2,2)=1 = 4 条
    expect(snapshot.stats.edge_count).toBe(4);
    const ids = snapshot.edges.map((e) => e.id);
    // 跨组不得有边（A–D 不在同一分组）
    expect(ids).not.toContain(
      `co_section:${[abilityNodeId("A"), abilityNodeId("D")].sort().join("|")}`,
    );
    // 同组必须有边
    expect(ids).toContain(
      `co_section:${[abilityNodeId("A"), abilityNodeId("B")].sort().join("|")}`,
    );
  });

  it("⑥ 同一行用空格接下一个分组：不被并成一个能力项", () => {
    const groups = parseBody("后端：Java、MQTT 数据库：MySQL、Redis", "tech");
    expect(groups.map((g) => g.group)).toEqual(["后端", "数据库"]);
    expect(groups[0]?.items).toEqual(["Java", "MQTT"]);
    expect(groups[1]?.items).toEqual(["MySQL", "Redis"]);

    const store = makeStore([
      { key: "skills", sections: [section(1, "技能清单", "后端：Java、MQTT 数据库：MySQL、Redis")] },
    ]);
    const snapshot = run(store);
    expect(labels(snapshot)).not.toContain("MQTT 数据库：MySQL");
    expect(labels(snapshot)).toEqual(expect.arrayContaining(["Java", "MQTT", "MySQL", "Redis"]));
  });

  it("⑦ 分组级停用：`证书：` 组内的资质不成为能力节点", () => {
    expect(isStopwordGroup("证书")).toBe(true);
    expect(isStopwordGroup("数据库")).toBe(false);

    const store = makeStore([
      {
        key: "skills",
        sections: [
          section(1, "技能清单", "后端：Java 证书：移动互联网应用开发职业技能等级证书、JavaWeb应用开发职业技能等级证"),
        ],
      },
    ]);
    expect(labels(run(store))).toEqual(["Java"]);
  });

  it("⑧ 软技能取分组名（body 是散文，碎片不是能力）", () => {
    const store = makeStore([
      {
        key: "soft_skills",
        sections: [
          section(1, "个人特质", "团队领导力：曾担任6人项目团队负责人，协调客户端、服务端开发。学习能力：从Java到AI工具快速掌握。"),
        ],
      },
    ]);
    const snapshot = run(store);
    expect(labels(snapshot)).toEqual(expect.arrayContaining(["团队领导力", "学习能力"]));
    expect(labels(snapshot)).not.toContain("协调客户端");
    expect(labels(snapshot)).not.toContain("曾担任6人项目团队负责人");
    expect(snapshot.nodes.every((n) => n.category === "soft")).toBe(true);
  });

  it("⑨ 快照通过契约校验：id 稳定、stats 自洽、无重复节点", () => {
    const store = makeStore([
      { key: "skills", sections: [section(1, "技能", "后端：Java、Spring Boot")] },
    ]);
    const snapshot = run(store);
    const ids = snapshot.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snapshot.stats.node_count).toBe(snapshot.nodes.length);
    expect(snapshot.stats.edge_count).toBe(snapshot.edges.length);
    // 同一输入两次抽取，id 必须一致（前端选中态依赖）
    expect(run(store).nodes.map((n) => n.id)).toEqual(ids);
  });
});

describe("跨簇边 co_project（T06）· 与 same_card（T03 裁决①）", () => {
  /** 技能清单（分组结构）+ projects 卡叙事（只做边证据）。 */
  function twoCardStore(projectBody: string) {
    return makeStore([
      {
        key: "skills",
        sections: [section(1, "技能清单", "后端：Java、Spring Boot\n数据库：MySQL、Redis")],
      },
      { key: "projects", sections: [section(2, "主要项目", projectBody)] },
    ]);
  }

  it("① `co_project` 不新增节点：节点仍只有 skills 卡抽出的 4 个", () => {
    const snapshot = run(
      twoCardStore("技术栈Java、Spring Boot、MySQL、TypeScript、pgvector、BGE-M3"),
    );
    expect(snapshot.nodes.map((n) => n.label).sort()).toEqual([
      "Java",
      "MySQL",
      "Redis",
      "Spring Boot",
    ]);
    // 叙事里出现但不在节点集的词，一个都不许变成节点
    for (const absent of ["TypeScript", "pgvector", "BGE-M3"]) {
      expect(snapshot.nodes.map((n) => n.label)).not.toContain(absent);
    }
    expect(snapshot.stats.node_count).toBe(4);
  });

  it("② 只在**跨组** pair 上生成 co_project（同组 pair 由 co_section 覆盖）", () => {
    const snapshot = run(twoCardStore("技术栈Java、Spring Boot、MySQL"));
    const coProject = snapshot.edges.filter((e) => e.kind === "co_project");
    const pairs = coProject.map((e) => [e.source, e.target].sort().join("|"));
    // Java/Spring Boot 同属「后端」→ 不产生 co_project；它们与 MySQL（数据库组）跨组 → 2 条
    expect(pairs).not.toContain([abilityNodeId("Java"), abilityNodeId("Spring Boot")].sort().join("|"));
    expect(pairs).toContain([abilityNodeId("Java"), abilityNodeId("MySQL")].sort().join("|"));
    expect(pairs).toContain([abilityNodeId("Spring Boot"), abilityNodeId("MySQL")].sort().join("|"));
    expect(coProject).toHaveLength(2);
  });

  it("③ 已有 `co_section` 的 pair 不再生成 `co_project`（不重复计数）", () => {
    // 叙事里只提到同组的两个后端项：它们已有 co_section，因此不该多出 co_project
    const snapshot = run(twoCardStore("技术栈Java、Spring Boot"));
    expect(snapshot.edges.filter((e) => e.kind === "co_project")).toHaveLength(0);
    expect(snapshot.edges.filter((e) => e.kind === "co_section")).toHaveLength(2);
  });

  it("④ 停用节只贡献边、不贡献节点（主要项目/项目经历 不进节点集）", () => {
    const snapshot = run(twoCardStore("主要项目：实现智能问答、工单派发\n技术栈Java、MySQL"));
    const labels = snapshot.nodes.map((n) => n.label);
    expect(labels).not.toContain("实现智能问答");
    expect(labels).not.toContain("工单派发");
    expect(snapshot.edges.some((e) => e.kind === "co_project")).toBe(true);
  });

  it("⑤ same_card 只出现在 soft_skills 卡内，skills 卡不生成", () => {
    const store = makeStore([
      { key: "skills", sections: [section(1, "技能", "后端：Java、Spring Boot")] },
      {
        key: "soft_skills",
        sections: [
          section(2, "个人特质", "团队领导力：曾担任6人团队负责人。学习能力：快速掌握新工具。社团管理：团委负责人。"),
        ],
      },
    ]);
    const snapshot = run(store);
    const sameCard = snapshot.edges.filter((e) => e.kind === "same_card");
    expect(sameCard).toHaveLength(3); // C(3,2)
    // 端点必须全部是 soft 节点
    const softIds = new Set(
      snapshot.nodes.filter((n) => n.category === "soft").map((n) => n.id),
    );
    for (const edge of sameCard) {
      expect(softIds.has(edge.source)).toBe(true);
      expect(softIds.has(edge.target)).toBe(true);
    }
    // skills 卡 2 个节点不得出现 same_card 边
    expect(snapshot.edges.filter((e) => e.kind === "same_card")).toHaveLength(3);
  });

  it("⑥ 边类型枚举精确为 4 项（加法式扩展，不得放宽成 partial）", () => {
    expect([...AbilityEdgeKindSchema.options].sort()).toEqual([
      "co_project",
      "co_section",
      "related",
      "same_card",
    ]);
  });
});

describe("项目级切分（T06 修订）· splitProjects 与 co_project 计权", () => {
  /** 两个项目写在同一节里（真实数据形态：`1. … 2. …`）。 */
  const TWO_PROJECTS = "1. CampusMind 平台：技术栈Java、Spring Boot、Redis、Vue3。2. 电子围栏检测系统：PyTorch+YOLO，实现港口目标检测。";

  it("① 编号切分：同一节里不同项目的两个能力不产生 co_project（YOLO ↔ Spring Boot 为 0）", () => {
    const store = makeStore([
      {
        key: "skills",
        sections: [section(1, "技能清单", "后端：Java、Spring Boot、MQTT\n数据库：Redis\nAI与智能：YOLO、PyTorch\n前端协作：Vue3")],
      },
      { key: "projects", sections: [section(2, "主要项目", TWO_PROJECTS)] },
    ]);
    const snapshot = run(store);
    const pair = (a: string, b: string) =>
      snapshot.edges.find((e) => {
        const ids = [e.source, e.target].sort().join("|");
        return ids === [abilityNodeId(a), abilityNodeId(b)].sort().join("|");
      });
    // Spring Boot 在项目 1，YOLO 在项目 2 → 不得有边
    expect(pair("Spring Boot", "YOLO")).toBeUndefined();
    // 同项目内的两个不同组能力（Spring Boot 后端 / Vue3 前端协作）仍然有 co_project
    expect(pair("Spring Boot", "Vue3")?.kind).toBe("co_project");
    expect(pair("Spring Boot", "Vue3")?.weight_raw).toBe(1);
  });

  it("② weight = 出现在几个项目里（同一项目在 2 节里重复描述 → 计 2，不是 1 也不是 4）", () => {
    const store = makeStore([
      { key: "skills", sections: [section(1, "技能清单", "后端：Java、Spring Boot\n数据库：Redis")] },
      // 同一张 projects 卡里两条**内容不同**的叙事节，各含一个项目，都提到 Spring Boot 与 Redis
      {
        key: "projects",
        sections: [
          section(2, "主要项目", "1. A 系统：Spring Boot、Redis 实现。"),
          section(3, "projects", "1. B 系统：使用 Spring Boot 与 Redis。"),
        ],
      },
    ]);
    const snapshot = run(store);
    const edge = snapshot.edges.find((e) => {
      const ids = [e.source, e.target].sort().join("|");
      return ids === [abilityNodeId("Spring Boot"), abilityNodeId("Redis")].sort().join("|");
    });
    expect(edge?.kind).toBe("co_project");
    expect(edge?.weight_raw).toBe(2);
  });

  it("③ 无编号的连续叙事整体当一个项目（不硬切）", () => {
    expect(splitProjects("负责某系统开发，使用 Java 与 Redis。")).toEqual([
      "负责某系统开发，使用 Java 与 Redis。",
    ]);
    // 序号不从 1 开始 / 不连续 → 也整体当一个项目
    expect(splitProjects("2. 第二项：Java\n3. 第三项：Redis")).toHaveLength(1);
    expect(splitProjects("1. 第一项：Java\n3. 第三项：Redis")).toHaveLength(1);
    // 正常连续编号才切
    expect(splitProjects("1. 第一项：Java\n2. 第二项：Redis")).toHaveLength(2);
  });

  it("④ 版本号/型号不会被当成项目编号（`Spring Boot 3、` / `2026.03`）", () => {
    // 这条是真实数据踩出来的：`Spring Boot 3、PostgreSQL` 的 "3、" 曾把序号序列打乱
    expect(splitProjects("1. A 项：使用 Spring Boot 3、PostgreSQL 与 Redis。")).toHaveLength(1);
    expect(splitProjects("1. A 项 2026.03-至今：Java。2. B 项：Redis。")).toHaveLength(2);
  });
});

describe("项目级切分 · 真实 `项目经历` 原文回归（T06 定稿）", () => {
  /**
   * 真实库 `skills/项目经历` 原文（4 个项目挤在**同一行**，用 `。2.` 分隔）。
   * 之所以要拿真文本，是因为 lead 给的行首编号正则 `/^\s*(\d{1,2})[.．、)]/m`
   * 在这种单行正文上只能切出 1 段（实测：7 个叙事节里只有 2 个含换行）。
   */
  const REAL_PROJECT_TEXT =
    "1. CampusMind Assistant (AI Agent平台) 2026.03-至今：负责人/独立开发，技术栈Java 21、Spring Boot3、PostgreSQL、pgvector、Redis、Vue3、TypeScript、BGE-M3、Whisper、GPT-SoVITS。面向高校的AI Agent平台，提供智能问答、动态表单生成、审批协同等。" +
    "2. 基于低代码+微信小程序的设备管理系统 2024.11-2025.05：参与Spring Boot后端开发、数据库设计、Redis缓存、MQTT硬件联调。" +
    "3. 基于HarmonyOS与AI大模型的车联网系统 2024.07-2024.12：负责人，设计数据流架构、MQTT通信、集成DeepSeek大模型，协调6人团队。" +
    "4. 电子围栏检测系统 (YOLO+PyTorch) 商业项目：实现港口目标检测与越界识别。";

  function realStore() {
    return makeStore([
      {
        key: "skills",
        sections: [
          section(
            1,
            "技能清单",
            "后端：Java、Spring Boot、MQTT\n数据库：Redis、PostgreSQL\nAI与智能：YOLO、PyTorch\n前端协作：Vue3\n工程工具：Git",
          ),
          section(2, "项目经历", REAL_PROJECT_TEXT),
        ],
      },
    ]);
  }

  const edgeBetween = (snapshot: ReturnType<typeof run>, a: string, b: string) =>
    snapshot.edges.find((e) => {
      const ids = [e.source, e.target].sort().join("|");
      return ids === [abilityNodeId(a), abilityNodeId(b)].sort().join("|");
    });

  it("① 真实原文切出 4 个项目体；YOLO 与 Spring Boot 分属不同项目 → 0 条 co_project", () => {
    const broken = splitProjects(REAL_PROJECT_TEXT);
    expect(broken).toHaveLength(4);
    // 切分后第 1 个项目含 Spring Boot、不含 YOLO；第 4 个项目含 YOLO
    expect(broken[0]).toContain("Spring Boot");
    expect(broken[0]).not.toContain("YOLO");
    expect(broken[3]).toContain("YOLO");
    expect(broken[3]).not.toContain("Spring Boot");

    const snapshot = run(realStore());
    expect(edgeBetween(snapshot, "YOLO", "Spring Boot")).toBeUndefined();
    // 反向对照：同组（后端）的 Java↔Spring Boot 仍是 co_section，不因切分丢失
    expect(edgeBetween(snapshot, "Java", "Spring Boot")?.kind).toBe("co_section");
  });

  it("② 同一项目内的跨组 pair 仍产生 co_project，且 weight 按项目数计", () => {
    const snapshot = run(realStore());
    // Spring Boot（后端）与 Vue3（前端协作）只在第 1 个项目里同时出现 → 1
    const edge = edgeBetween(snapshot, "Spring Boot", "Vue3");
    expect(edge?.kind).toBe("co_project");
    expect(edge?.weight_raw).toBe(1);
    // Spring Boot 与 Redis：项目 1（CampusMind）与项目 2（设备管理）都有 → 2
    const sbRedis = edgeBetween(snapshot, "Spring Boot", "Redis");
    expect(sbRedis?.kind).toBe("co_project");
    expect(sbRedis?.weight_raw).toBe(2);
  });

  it("③ 无编号叙事节整体算一个项目体（不因无编号而丢边）", () => {
    const store = makeStore([
      { key: "skills", sections: [section(1, "技能清单", "后端：Java、Spring Boot\n数据库：Redis")] },
      {
        key: "projects",
        sections: [section(2, "主要项目", "参与某系统开发，使用 Spring Boot 与 Redis，负责接口设计与缓存优化。")],
      },
    ]);
    const snapshot = run(store);
    const edge = edgeBetween(snapshot, "Spring Boot", "Redis");
    expect(edge?.kind).toBe("co_project");
    expect(edge?.weight_raw).toBe(1);
  });
});
