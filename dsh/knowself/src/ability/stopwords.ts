/**
 * 能力抽取的**停用表**（按真实库的 section.title 定，不是凭空猜）。
 *
 * ## 为什么需要它
 * 真实数据里 `card_sections.title` 全是通用词：「技能」「技能清单」「专业技能」「技术栈」
 * 「skills」「荣誉奖项」「实习经历」「个人特质」……若把标题当能力项（架构师原案），
 * 只会抽出 3~4 个同义节点，而 `Java` / `Spring Boot` / `MySQL` 一个都不会出现。
 *
 * 所以本表只回答一个问题：**这一节要不要抽**。能力项一律从 `body` 抽
 * （见 `extract.ts`），标题仅用于「过滤」与「归类」。
 *
 * ## 判定口径
 * 1. 归一化（NFKC + 小写 + 去空白/标点）后查表；
 * 2. 命中**前缀/包含**关系也算命中（`工作经历（一）`、`基本信息（更新于2024）`）；
 * 3. 非语义 key（纯数字 / 纯符号，如 `123`）一律跳过 —— 真实库里确实存在这种标题。
 */

/**
 * 归一化标题：用于**比较**（全角转半角 NFKC、小写、去空白与标点）。
 *
 * 放在本文件而不是 `extract.ts`，是为了让依赖方向单向：`extract → stopwords`。
 * 若放 `extract` 里、再由本文件 import，两个模块互为依赖（循环），esbuild 与
 * vitest 的处理顺序不同会让「哪个先初始化」变成隐式契约 —— 不值得。
 *
 * @param raw 原始标题
 * @returns 只含字母/数字/汉字的小写串
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 停用标题（归一化后逐字比较 + 包含匹配）。
 *
 * 分组仅为可读性，判定时是同一个集合。
 */
export const STOPWORD_TITLES: readonly string[] = [
  // 荣誉 / 资质：标题本身不是能力项，正文里的「一等奖」也不是能力
  "荣誉奖项",
  "荣誉",
  "获奖记录",
  "获奖情况",
  "奖项",
  "honors",
  "awards",
  "certificates",
  "证书",
  // 教育
  "教育背景",
  "教育经历",
  "education",
  "学历",
  // 基本信息：联系人式字段，属档案而非能力
  "基本信息",
  "基础信息",
  "个人基本信息",
  "basic_info",
  "basicinfo",
  "personal_info",
  "personalinfo",
  "profile",
  "contact",
  "联系方式",
  "location",
  "所在地",
  "现居地",
  // 职业 / 经历类：事件而非能力项
  "职业",
  "求职意向",
  "职业意向",
  "实习经历",
  "工作经历",
  "职业经历",
  "项目经历",
  "work",
  "experience",
  "internship",
  "projects",
  // 其他显而易见的非能力节
  "主要项目",
  "项目",
  "其他",
  "总结",
  "自我评价",
  "备注",
  "misc",
  // 证书类：资质不是"能力项"（与荣誉奖项同口径）。真实库里有 `资格证书` 节，
  // body 是「移动互联网应用开发职业技能等级证书；…」—— 抽出来只会是档案字段。
  "资格证书",
  "资格证书与语言能力",
  "证书",
  "certificate",
  "certificates",
  "certification",
];

/**
 * 分组名（`类别：` 左边那段）的停用集合。
 *
 * 为什么还要单独一层：真实数据里 `技能清单` 的 body 末尾有一组
 * `证书：移动互联网应用开发职业技能等级证书、JavaWeb应用开发职业技能等级证` ——
 * 节标题是「技能清单」（该抽），但这一**组**的内容是资质，不该成为能力节点。
 */
const STOPWORD_GROUPS: ReadonlySet<string> = new Set(
  ["证书", "资格证书", "荣誉", "奖项", "获奖", "荣誉奖项", "资历", "certificate", "certificates", "awards", "honors"].map(
    (item) => normalizeTitle(item),
  ),
);

/** 归一化后的停用集合（建一次，抽取时 O(1) 查）。 */
const STOPWORD_SET: ReadonlySet<string> = new Set(
  STOPWORD_TITLES.map((item) => normalizeTitle(item)),
);

/** 归一化后仍全是非语义字符（纯数字/纯符号）的标题一律视为非语义。 */
const NON_SEMANTIC = /^[\d\s\p{P}\p{S}]+$/u;

/**
 * 该 section 标题是否应被**跳过**（不参与能力抽取）。
 *
 * @param title 原始 section 标题
 * @returns true = 跳过
 */
export function isStopwordTitle(title: string): boolean {
  const key = normalizeTitle(title);
  if (key === "") return true; // 空标题无法归类，按跳过处理
  if (NON_SEMANTIC.test(key)) return true; // `123` 这类非语义 key
  if (STOPWORD_SET.has(key)) return true;
  // 包含匹配：`工作经历（2023-2024）` / `基本信息 Basic Info`
  for (const word of STOPWORD_SET) {
    if (word.length >= 2 && key.includes(word)) return true;
  }
  return false;
}

/**
 * 该「类别：」分组是否应被跳过（组内项目非能力项，如 `证书：`）。
 *
 * @param group 已展示归一化的分组名
 * @returns true = 跳过该组的全部项目
 */
export function isStopwordGroup(group: string): boolean {
  const key = normalizeTitle(group);
  if (key === "") return false;
  if (STOPWORD_GROUPS.has(key)) return true;
  for (const word of STOPWORD_GROUPS) {
    if (word.length >= 2 && key.includes(word)) return true;
  }
  return false;
}
