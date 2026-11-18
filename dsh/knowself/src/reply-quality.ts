/**
 * 回复文本质量护栏。
 *
 * 2026-11-17 真实事故：对方一直答"楼下"，代理连续四条都在问"你昨晚没回宿舍 去哪了"，
 * 还出现过 `1 你昨晚没回宿舍啊`（编号残留）和「在楼下看到你了，别急」（编造亲眼所见）。
 * 小模型 + 「目标=套话」的提示词，很容易退化成复读机。这里做三件纯函数级的事：
 *   1. `cleanReplyBody`：把生成结果规整成一条可直接发的微信正文（去编号/列表/引号/换行）；
 *   2. `isRepetitiveReply`：和最近已发的原话比对，判"换个说法又问一遍"；
 *   3. `compactHistory`：折叠历史里的连续重复，避免上下文里全是"楼下 楼下 楼下"。
 *
 * @module @knowself/dsh-plugin/reply-quality
 */

/** 一条消息在历史里的最小形状。 */
export interface HistoryMessage {
  role: string;
  content: string;
}

/** 行首编号 / 列表符：`1 ` `1.` `1、` `1)` `-` `*` `•`。 */
const LEADING_MARKER = /^\s*(?:\d{1,2}\s*[.、)）]?|[-*•·])\s+/;
/** 包裹引号。 */
const WRAPPING_QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;
/** markdown 粗体/斜体/代码标记。 */
const INLINE_MARKUP = /[*_`]+/g;
/** 微信括号表情：`[呲牙]` `[坏笑]` `[旺柴]` 等短 token。 */
const WECHAT_EMOJI_BRACKET = /\[[^\s[\]]{1,8}\]/g;
/** 常见 Unicode emoji 区块 + 变体选择符 + ZWJ。 */
const UNICODE_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}]/gu;

/**
 * 去掉模型乱加的表情：微信 `[呲牙]` 这类括号表情 + Unicode emoji。
 *
 * 真实事故：代理在「猜你今天又没闲着」后面随手接 `[呲牙]`，还在「运动量够了」后面接 `[旺柴]`，
 * 都是凭空加的、和语境对不上的表情。这里统一剥掉，只留纯文字。
 */
export function stripChatEmoji(text: string): string {
  return text
    .replace(WECHAT_EMOJI_BRACKET, "")
    .replace(UNICODE_EMOJI, "")
    .replace(/ +/g, " ")
    .trim();
}

/**
 * 不是表情的方括号 token：导出占位。
 *
 * 真实事故：`[类型50]` 被当成表情统计进库，模型从库里挑中它，
 * 发出去成了字面文本「我这刚下班 晚上准备干点啥去[类型50]」。
 * 微信内置表情一定是中文/英文名（呲牙、旺柴、Emm），不会是「类型50」这种占位。
 */
export const NON_EMOJI_BRACKET = /^\[(?:类型\s*\d+|图片|语音|视频|文件|动画表情|表情|红包|转账|链接|音乐|视频号|小程序|引用|合并转发|拍一拍|位置|名片|通话|系统消息|撤回)\]$/;

/** 是否是**真的**微信表情码或 Unicode emoji（占位符不算）。 */
export function isRealEmoji(token: string): boolean {
  if (NON_EMOJI_BRACKET.test(token)) return false;
  return /^\[[^\s[\]]{1,8}\]$/.test(token)
    || /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]$/u.test(token);
}

/**
 * 抽出一条消息里用到的表情（微信括号码 + Unicode emoji），按出现顺序。
 *
 * 用途：从历史里统计「这个人平时爱用哪些表情」，建一个**只属于他**的表情库。
 * `[类型50]` 这类导出占位会被排除，不进库。
 */
export function extractEmoji(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\[[^\s[\]]{1,8}\]/g)) {
    if (isRealEmoji(match[0])) found.push(match[0]);
  }
  for (const match of text.matchAll(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu)) found.push(match[0]);
  return found;
}

/**
 * 只保留「表情库里有的」表情，其余全部剥掉。
 *
 * 这是「允许发表情」和「原来的全删」之间的中间态：既能用本人的真表情，
 * 又挡住模型自己发明（`[呲牙]` 挂在「猜你今天又没闲着」后面那种事故）。
 * 占位符（`[类型50]`/`[图片]`）**无论是否在库里都剥掉**——旧画像可能已经把脏数据收进库了。
 *
 * @param text - 待清洗正文。
 * @param allowed - 允许保留的表情集合；空集合 = 一个都不留。
 */
export function filterEmoji(text: string, allowed: ReadonlySet<string>): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  const keep = (token: string): string => {
    if (isRealEmoji(token) && allowed.has(token)) return token;
    dropped.push(token);
    return "";
  };
  const cleaned = text
    .replace(/\[[^\s[\]]{1,8}\]/g, keep)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, keep)
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text: cleaned, dropped };
}

/**
 * 对方是不是在**明确收尾**（这一轮可以不回）。
 *
 * 只有这种消息允许模型沉默；「哦」「嗯」「🤔」「表情」都不算收尾——
 * 产品要求是「敷衍也不要停，继续往目标上带」，沉默等于任务停摆。
 */
const FAREWELL_PATTERN = /(晚安|睡了|先睡|拜拜|先这样|不聊了|下了|出门了|忙去了|回头聊|下次聊)/;
export function isFarewell(text: string): boolean {
  return FAREWELL_PATTERN.test(text);
}

/**
 * 抽签：这一条消息允不允许带表情。
 *
 * 用真实统计出来的频率抽，而不是让模型自己决定「这条该不该加」——
 * 事故就是模型乱加出来的。`rate <= 0` 表示这个人本来就不发表情。
 */
export function emojiAllowance(rate: number, random: () => number): boolean {
  if (!(rate > 0)) return false;
  return random() < Math.min(1, rate);
}

/**
 * 把模型输出规整成一条可发送的正文。
 *
 * @param raw - 模型原始输出。
 * @param maxLength - 最大字符数（超出截断），默认 300。
 * @param keepEmoji - 保留表情（由调用方再用 `filterEmoji` 按表情库过滤）；默认剥掉。
 * @returns 单行纯文本；模型什么都没说时返回空串。
 */
export function cleanReplyBody(raw: string, maxLength = 300, keepEmoji = false): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") return "";
  // 多行只保留第一句有意义的（避免把"解释+正文"整段发出去）。
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  text = lines[0] ?? "";
  text = text.replace(LEADING_MARKER, "");
  text = text.replace(INLINE_MARKUP, "");
  text = text.replace(WRAPPING_QUOTES, "").trim();
  // 去掉模型常见的"回复："前缀。
  text = text.replace(/^(?:回复|答复|消息)\s*[:：]\s*/, "");
  // 剥掉乱加的表情（微信 [呲牙] 括号表情 + Unicode emoji）；要保留时交给 filterEmoji 按库过滤。
  if (!keepEmoji) text = stripChatEmoji(text);
  if (text.length > maxLength) text = text.slice(0, maxLength).trim();
  return text;
}

/**
 * 归一化后才做重复比较：去掉空白、标点、符号，统一小写。
 *
 * @param text - 任意文本。
 * @returns 只含字母/数字/汉字的紧凑串。
 */
export function normalizeForRepeat(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** 取归一化文本的字符集合（比二元组更耐住「换个说法再问一遍」）。 */
function charSet(text: string): Set<string> {
  return new Set(text);
}

/**
 * 判断新草稿是否在重复最近说过的话。
 *
 * 判定顺序：
 *   1. 归一化后完全相同；
 *   2. 一方包含另一方（且都不短于 6 个字）——「你昨晚没回宿舍」被包含在更长的复读里；
 *   3. 字符集合 Jaccard ≥ 阈值（默认 0.75）——「昨晚没见你回宿舍 哪去了」与
 *      「你昨晚没回宿舍 去哪了」这类换词复读，字符集合几乎重合，二元组反而会漏判。
 * 少于 6 个字的短句只做「完全相同」判定：聊天里「好」「在的」「楼下」本来就会重复。
 *
 * @param candidate - 本次生成的正文。
 * @param recentSent - 最近发出去的原话（旧→新）。
 * @param threshold - Jaccard 阈值，默认 0.75。
 * @returns 是否判为重复。
 */
export function isRepetitiveReply(candidate: string, recentSent: readonly string[], threshold = 0.75): boolean {
  const normalized = normalizeForRepeat(candidate);
  if (normalized === "") return false;
  const chars = charSet(normalized);
  for (const previous of recentSent) {
    const old = normalizeForRepeat(previous);
    if (old === "") continue;
    if (old === normalized) return true;
    if (normalized.length < 6 || old.length < 6) continue;
    if (normalized.includes(old) || old.includes(normalized)) return true;
    const oldChars = charSet(old);
    let shared = 0;
    for (const char of chars) if (oldChars.has(char)) shared += 1;
    const union = chars.size + oldChars.size - shared;
    if (union > 0 && shared / union >= threshold) return true;
  }
  return false;
}

/**
 * 合并「索引里的历史」与「刚从微信读到的最近几条」，让模型总能看到最新几轮。
 *
 * 为什么需要：persons 库靠定期导入，永远落后几分钟；而回复必须接得上"我刚说过什么、
 * 对方上一句答了什么"。近处用实时读到的（`live`），远处用索引里的（`indexed`）。
 *
 * @param indexed - 索引上下文（可能落后）。
 * @param live - 从微信本地库读到的最近消息（新）。
 * @param limit - 合并后最多保留几条，默认 24。
 * @returns 合并、去重并按时间排序后的历史。
 */
export function mergeLiveHistory(
  indexed: readonly TimedMessage[],
  live: readonly TimedMessage[],
  limit = 24,
): TimedMessage[] {
  const seen = new Set<string>();
  const key = (item: TimedMessage): string => `${item.role}:${normalizeForRepeat(item.content)}`;
  const merged: TimedMessage[] = [];
  for (const item of indexed) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    merged.push(item);
  }
  for (const item of live) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    merged.push(item);
  }
  if (merged.every((item) => typeof item.ts_ms === "number")) {
    merged.sort((left, right) => (left.ts_ms ?? 0) - (right.ts_ms ?? 0));
  }
  return merged.slice(-Math.max(1, limit));
}

/** 折叠历史里连续重复的消息（保留第一条），并只留最后 `limit` 条：避免上下文里全是「楼下」。 */
export function compactHistory<T extends HistoryMessage>(items: readonly T[], limit = 16): T[] {
  const collapsed: T[] = [];
  for (const item of items) {
    const previous = collapsed.at(-1);
    if (previous !== undefined
      && previous.role === item.role
      && normalizeForRepeat(previous.content) === normalizeForRepeat(item.content)) {
      continue;
    }
    collapsed.push(item);
  }
  return collapsed.slice(-Math.max(1, limit));
}

/** 带时间戳的历史消息。 */
export interface TimedMessage extends HistoryMessage {
  ts_ms?: number;
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 把时间戳压成聊天里能说清"这是几点"的短标签。
 *
 * @param tsMs - 消息时间（epoch ms）。
 * @param nowMs - 当前时间（epoch ms）。
 * @returns 同一天返回 `13:05`，跨天返回 `11-16 22:41`；时间缺失返回空串。
 */
export function formatClock(tsMs: number | undefined, nowMs: number): string {
  if (tsMs === undefined || !Number.isFinite(tsMs) || tsMs <= 0) return "";
  const at = new Date(tsMs);
  const now = new Date(nowMs);
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate();
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return sameDay ? clock : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/**
 * 渲染历史为「时间 + 说话人 + 内容」的行，让模型能对齐时态。
 *
 * @param items - 历史消息（旧→新）。
 * @param nowMs - 当前时间。
 * @returns 每行一条，例如 `[13:05] 对方：打电话问过了`。
 */
export function formatHistoryLines(items: readonly TimedMessage[], nowMs: number): string[] {
  return items.map((item) => {
    const clock = formatClock(item.ts_ms, nowMs);
    const who = item.role === "me" ? "我" : "对方";
    return clock === "" ? `${who}：${item.content}` : `[${clock}] ${who}：${item.content}`;
  });
}

/**
 * 从历史里挑出「用户本人平时怎么说话」的样例。
 *
 * 为什么需要：画像（persona）是模型总结出来的抽象描述（"轻松、调侃"），
 * 而真实口吻是"冷静""都有""我知道"这种极短句。给模型看原话，比形容它更有效。
 *
 * @param items - 历史消息（旧→新）。
 * @param limit - 最多几条，默认 8。
 * @param exclude - 需要排除的句子（归一化后），通常是自动化自己发过的正文。
 * @returns 用户自己发过的短句（去重、去重内容）。
 */
export function styleExamples(items: readonly HistoryMessage[], limit = 8, exclude?: ReadonlySet<string>): string[] {
  const picked: string[] = [];
  for (let index = items.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const item = items[index];
    if (item === undefined || item.role !== "me") continue;
    const text = item.content.trim();
    // 只要像"打字聊天"的短句：2~40 字，且不是链接/系统消息。
    if (text.length < 2 || text.length > 40) continue;
    if (/^https?:|^<|^\[/.test(text)) continue;
    // 排除自动化自己发过的话：否则模型一边看"我平时这么说"，一边把上一轮的机器人腔学回来。
    if (exclude !== undefined && exclude.has(normalizeForRepeat(text))) continue;
    if (picked.includes(text)) continue;
    picked.push(text);
  }
  // 由新到旧返回：越近的原话越能代表"现在的口吻"。
  return picked;
}

/**
 * 时态/日期漂移词：模型自行引入这些**未来**时间最容易和对方说的对不上。
 *
 * 只收未来词：过去词（「昨晚/昨天」）在真实对话里经常是正常指代（"你昨晚去哪了"），
 * 一刀切会误杀。真实事故是「要去鲤城区」（今天去）被写成「明天几点去」。
 */
const DRIFT_TIME_WORDS = ["明天", "明早", "明晚", "明天早上", "明天上午", "明天下午", "后天", "下周"] as const;

/**
 * 判断回复是否凭空引入了一个「对方没说、且当下对不上」的时间词。
 *
 * 真实事故：对方说「要去鲤城区」（今天要去），代理回「明天几点去」；
 * 对方说「打电话问过了」，代理还在说「电话明天打过去问清楚」。
 *
 * @param body - 待发送正文。
 * @param referenceText - 对方最近说过的话（拼接后的文本）。
 * @returns 命中的漂移词，没有则 undefined。
 */
export function findUnsupportedTimeWord(body: string, referenceText: string): string | undefined {
  return DRIFT_TIME_WORDS.find((word) => body.includes(word) && !referenceText.includes(word));
}

/**
 * 对方可能想套取的敏感信息类别。命中即要求代理「打马虎眼」，
 * 绝不给出具体数字 / 地址 / 账号 / 姓名 / 单位等可定位到现实身份的内容。
 */
const SENSITIVE_ASK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "证件号", pattern: /身份证|证件号|证件|社保卡|护照|驾驶证|车牌/ },
  { label: "银行卡", pattern: /银行卡|卡号|信用卡|储蓄卡|收款码/ },
  { label: "密码/验证码", pattern: /密码|验证码|动态码|支付码|付款码|密保/ },
  { label: "住址/位置", pattern: /住址|住哪|住在|家庭住址|门牌|具体地址|定位|位置共享|几号楼|几单元|几栋|哪个小区|哪个楼盘/ },
  { label: "工作单位/收入", pattern: /哪个单位|公司名字|公司名|在哪上班|工资|收入|薪资|月薪|年薪|存款|余额|年终奖/ },
  { label: "联系方式", pattern: /手机号|电话号码|座机|加一下微信|扫我|二维码|群号/ },
  { label: "借钱/转账", pattern: /借钱|借我|借点|转账|打钱|转我|贷款|担保|帮忙付|代付|垫付/ },
];

/** 判断对方这轮是否在打听敏感信息；返回命中的类别名，没有则 undefined。 */
export function detectSensitiveAsk(text: string): string | undefined {
  for (const item of SENSITIVE_ASK_PATTERNS) {
    if (item.pattern.test(text)) return item.label;
  }
  return undefined;
}

/** 判断待发送正文是否像要泄露敏感信息；返回命中的类别名，没有则 undefined。 */
export function containsSensitiveDisclosure(line: string): string | undefined {
  // 连续数字串：按长度区分证件号(15/18) / 银行卡(16-19) / 手机号(11)。按「每段连续数字」判断，
  // 避免 19 位卡号被 \d{15,18} 误判成证件号、18 位证件号又被 \d{16,19} 误判成卡号。
  const runs = line.match(/\d+/g) ?? [];
  for (const run of runs) {
    const length = run.length;
    if (length === 15 || length === 18) return "证件号";
    if (length >= 16 && length <= 19) return "银行卡号";
    if (length === 11 && /^1[3-9]/.test(run)) return "手机号";
  }
  if (/密码|验证码|动态码|支付码/.test(line)) return "密码/验证码";
  if (/(?:账号|账户)\s*[:：]?\s*\d{6,}/.test(line)) return "账号";
  return undefined;
}

/** 对方「明确转移/拒绝话题」的措辞。命中即要求这一轮别再硬塞目标，先顺着他。 */
const TOPIC_REDIRECT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "别扯开话题", pattern: /别扯|扯开话题|别岔|别转移|说正事|回到正题/ },
  { label: "没得商量", pattern: /没得商量|没商量|免谈/ },
  { label: "先做别的/换个话题", pattern: /现在先|先干|先做|先别|先不聊|先不扯|不说这个|换个话题|别问这个|别打听/ },
  { label: "不聊了/打住", pattern: /别说了|不聊了|不想说|打住|停一停/ },
];

/** 判断对方这轮是否在拒绝/转移话题；返回命中的类别名，没有则 undefined。 */
export function detectTopicRedirect(text: string): string | undefined {
  for (const item of TOPIC_REDIRECT_PATTERNS) {
    if (item.pattern.test(text)) return item.label;
  }
  return undefined;
}

/** 一个字级别的确认（「可以/行/好/嗯」）——这种不该被 silent 晾着，得回个短确认。 */
const SHORT_ACK = /^(?:可以|行|好|嗯+|好呀|行吧|成|中|ok|好的|收到|没问题|没问题呀|行啊|好啊|可以啊)[。!！~～….]*$/i;

export function isShortAck(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > 6) return false;
  return SHORT_ACK.test(trimmed);
}

/**
 * 压缩检索回来的上下文，减少 token 又不丢关键信息：
 *   1. 丢掉空文本与 `<` 开头的 XML/媒体原始体；
 *   2. 按「角色 + 归一化文本」去重（「楼下」不重复占位）；
 *   3. 每条截到 `maxPerMessage` 字（聊天消息本来就是短句，截断损失很小）；
 *   4. 有 ts 时按时间升序，最后只保留 `limit` 条。
 *
 * @param items - 检索/索引返回的消息（需含 role + content）。
 * @param opts.maxPerMessage - 每条最多保留多少字，默认 60。
 * @param opts.limit - 最多保留几条，默认 16。
 */
export function compactReplyContext<T extends { role: string; content: string; ts_ms?: number }>(
  items: readonly T[],
  opts: { maxPerMessage?: number; limit?: number } = {},
): T[] {
  const maxPerMessage = opts.maxPerMessage ?? 60;
  const limit = opts.limit ?? 16;
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    const text = item.content.trim();
    if (text === "" || text.startsWith("<")) continue;
    const key = `${item.role}:${normalizeForRepeat(text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clipped = text.length > maxPerMessage ? `${text.slice(0, maxPerMessage)}…` : text;
    kept.push({ ...item, content: clipped });
  }
  if (kept.every((item) => typeof item.ts_ms === "number")) {
    kept.sort((left, right) => (left.ts_ms ?? 0) - (right.ts_ms ?? 0));
  }
  return kept.slice(-Math.max(1, limit));
}

/** 「替本人做决定 / 承诺」的强措辞。命中即要求改写，改不掉就本轮不发。 */
const COMMITMENT_PATTERN = /我保证|我答应|我一定|我发誓|我承诺|包在我身上|这事我定了|那就这么定了|我明天就去|我现在就去|我马上就去/;

/**
 * 判断正文是否在替本人做承诺；返回命中的措辞，没有则 undefined。
 * 只收强措辞——「我觉得/我猜/我看看」这些不算承诺，避免误杀。
 */
export function detectCommitment(line: string): string | undefined {
  return COMMITMENT_PATTERN.exec(line)?.[0];
}

/** 防抖状态：正在等的消息 id、最后一条新消息的时间、这轮 burst 的起点。 */
export interface DebounceState {
  pendingId: string | null;
  pendingSince: number;
  burstStart: number;
}

export interface DebounceGateInput {
  /** 当前最新一条入站消息 id；没有则 null。 */
  newestId: string | null;
  now: number;
  debounceMs: number;
  debounceMaxMs: number;
  state: DebounceState;
}

/**
 * 对方连发多条时「等静默再回一条」的防抖门。
 *
 * - 新消息出现：重置静默计时（`pendingSince = now`），burst 起点只在从「无待回」变「有待回」时置位；
 * - 静默不足 `debounceMs` 且 burst 未超 `debounceMaxMs` → 返回 `wait=true`（继续等）；
 * - 静默够了或触顶 → 返回 `wait=false`（可以回）。
 *
 * `debounceMs <= 0` 时永远 `wait=false`（测试/未启用防抖）。
 */
export function debounceGate(input: DebounceGateInput): { wait: boolean; state: DebounceState } {
  const { newestId, now, debounceMs, debounceMaxMs } = input;
  if (newestId === null) {
    return { wait: false, state: { pendingId: null, pendingSince: 0, burstStart: 0 } };
  }
  const state: DebounceState = { ...input.state };
  if (state.pendingId === null) {
    state.pendingId = newestId;
    state.pendingSince = now;
    state.burstStart = now;
    return { wait: debounceMs > 0, state };
  }
  if (state.pendingId !== newestId) {
    // 新消息：重新开始静默计时，但 burst 起点不动（用于触顶保护）。
    state.pendingId = newestId;
    state.pendingSince = now;
    const elapsed = now - state.burstStart;
    const stillBursting = debounceMs > 0 && elapsed < debounceMaxMs;
    return { wait: stillBursting, state };
  }
  const quiet = now - state.pendingSince;
  const elapsed = now - state.burstStart;
  const stillBursting = debounceMs > 0 && quiet < debounceMs && elapsed < debounceMaxMs;
  return { wait: stillBursting, state };
}

/**
 * 同一开头词连刷：最近几句里有 ≥`limit` 句和你这句开头相同（归一化后前 2 个字）。
 *
 * 真实事故：陈炜那段 9 条里 5 条以「我猜」开头。整句相似度守卫（`isRepetitiveReply`）
 * 抓不到这种「句式模板化」——每句内容都不一样，但开口方式一模一样。
 */
export function sameOpenerStreak(candidate: string, recentSent: readonly string[], window = 4, limit = 2): string | undefined {
  const opener = normalizeForRepeat(candidate).slice(0, 2);
  if (opener.length < 2) return undefined;
  // 只看每句的「开头一小段」：模板化体现在开口的那几个字，而不是整句。
  // 用 includes 而不是 startsWith，因为「我猜」和「那我猜」是同一个口头禅。
  const hits = recentSent
    .slice(-window)
    .filter((line) => normalizeForRepeat(line).slice(0, 4).includes(opener)).length;
  return hits >= limit ? opener : undefined;
}

/**
 * 点评者腔 / AI 腔特征。
 *
 * 真实事故：「骂人还挺快」「气性不小」「你挺会转弯阿」——主语是**在评价对方**，
 * 像是旁边有人在记录，而不是当事人在聊天。这一类话真人几乎不会说。
 */
const CRITIC_TONE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/还挺(快|会|能|行|敢)/u, "点评对方"],
  [/挺(会|能|敢|快)/u, "点评对方"],
  [/气性|脾气不小|本事不小|长本事/u, "点评对方"],
  [/你(可真|还挺|真会|倒是会)/u, "点评对方"],
  [/倒是?会|可真会/u, "点评对方"],
  [/说白了|换句话说|其实吧|总的来说|总而言之/u, "AI 连接词"],
  [/不是.{0,6}而是/u, "AI 对仗句"],
  [/值得(一提|注意的是)/u, "AI 腔"],
  [/首先|其次|另外,/u, "AI 结构词"],
];

/** 命中点评者腔/AI 腔时返回标签，未命中返回 undefined。 */
export function detectCriticTone(line: string): string | undefined {
  for (const [pattern, label] of CRITIC_TONE_PATTERNS) if (pattern.test(line)) return label;
  return undefined;
}

/** 说明「这句是在回答」的标记词：对方提问时，回复里至少要有一个。 */
const ANSWER_MARKERS = [
  "是", "不是", "有", "没有", "没", "在", "不在", "好", "行", "可以",
  "不知道", "差不多", "一般", "还行", "对", "嗯", "不懂", "装了", "了",
] as const;

/**
 * 强答句标记（不含「了」）：「了」只表示完成态，不表示在回答。
 *
 * 保留给「反问」守卫使用，避免把「一堆破事 脑子都木了」当成已作答。
 */
const STRONG_ANSWER_MARKERS = [
  "是", "不是", "有", "没有", "没", "在", "不在", "好", "行", "可以",
  "不知道", "差不多", "一般", "还行", "对", "嗯", "不懂", "装了",
] as const;

/** 问句里的疑问成分：抽关键词时先剥掉，剩下的才是「对方在问什么」。 */
const QUESTION_FILLER = /什么|怎么|为啥|为什么|咋|哪|谁|多少|几点|是不是|有没有|吗|嘛|呢|啊|呀|吧|？|\?/g;

/**
 * 把问句压成「实义关键词」。
 *
 * 用途：判「对方问的事，回复里到底提没提」。真实事故是对方问「忙啥呢」，
 * 回复「一堆破事 脑子都木了 你呢 下班干啥去」——一个「忙」字都没有。
 */
export function questionKeywords(inbound: string): string[] {
  const stripped = inbound.replace(QUESTION_FILLER, "").trim();
  if (stripped.length < 2) return [];
  const words: string[] = [];
  for (const match of stripped.matchAll(/[A-Za-z]{3,}/g)) words.push(match[0].toLowerCase());
  const han = stripped.replace(/[^\u4e00-\u9fff]/g, "");
  for (let index = 0; index + 2 <= han.length; index += 1) words.push(han.slice(index, index + 2));
  return [...new Set(words)];
}

/**
 * 对方在提问、但回复里一个「答」的痕迹都没有（纯评价/纯阴阳）。
 *
 * 这是「回了但答非所问」的兜底：真实事故是对方问「今天天气如何」，
 * 代理回「刚嫌我无聊 转头问我天气 你挺会转弯阿」——提到了天气，却没答。
 */
export function missesQuestion(line: string, inboundIsQuestion: boolean): boolean {
  if (!inboundIsQuestion) return false;
  return !ANSWER_MARKERS.some((marker) => line.includes(marker));
}

/**
 * 对方问了你，你一句没答就反问回去。
 *
 * 真实事故：对方问「忙啥呢」→「一堆破事 脑子都木了 **你呢** 下班干啥去」。
 * 「了」把 missesQuestion 骗过去了，但「你呢」暴露了它在反问而不是回答。
 */
const DEFLECT_PATTERN = /(你呢|那你呢|你咋样|你怎么说|你什么情况)/;
export function deflectsQuestion(line: string, inboundIsQuestion: boolean): boolean {
  if (!inboundIsQuestion) return false;
  // 有强答句痕迹就不算纯反问（「我挺好的 你呢」是正常聊天）。
  if (STRONG_ANSWER_MARKERS.some((marker) => line.includes(marker))) return false;
  return DEFLECT_PATTERN.test(line);
}

/**
 * 对方问了你，你用「晚点再说」把它拖过去。
 *
 * 真实事故：对方追问「你忙啥呢」，代理回「累一天了 先躺会儿 作业晚点再说」——
 * 表面像在说话，实际一个信息都没给，对方的问题还挂在那里。
 */
const STALL_PATTERN = /(晚点再说|回头再说|等下再说|待会说|下次再说|以后再说)/;
export function stallsAnswer(line: string, inboundIsQuestion: boolean): boolean {
  return inboundIsQuestion && STALL_PATTERN.test(line);
}

/**
 * 把「对方已经做完的事」当成还没发生（时序错乱）。
 *
 * 真实事故：对方 19:04 说「下了」，19:06 代理问「你呢 下班干啥去」——
 * 她已经下班了，还在问下班要干什么。时态护栏只认「明天/昨天」，抓不到这种。
 */
const COMPLETED_STATE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["下了", "下班"],
  ["吃了", "吃饭"],
  ["到了", "过去"],
  ["睡了", "睡觉"],
];
const FUTURE_ASK = /(干啥|干嘛|去哪|准备|打算|要不要|要不要去)/;

/** 回复把对方已完成的动作当成将要做时，返回 `已完成→被当成将来`。 */
export function detectStaleCompletion(line: string, referenceText: string): string | undefined {
  for (const [done, base] of COMPLETED_STATE_PAIRS) {
    if (referenceText.includes(done) && line.includes(base) && FUTURE_ASK.test(line)) return `${done}→${base}`;
  }
  return undefined;
}

/**
 * 自我矛盾：刚说过「装了」，这轮又说「没装」。
 *
 * 真实事故：10:12「装了阿 不然我升级个啥」→ 10:14「哦 那这个我真没装」，
 * 两分钟内翻供，对方一眼看穿。只做少数明确动词对，避免误杀。
 */
const CONTRADICTION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["装了", "没装"],
  ["去了", "没去"],
  ["看过", "没看过"],
  ["发了", "没发"],
];

/** 与最近自己说过的话相矛盾时返回 `旧→新`，否则 undefined。 */
export function detectSelfContradiction(line: string, recentSent: readonly string[]): string | undefined {
  const recent = recentSent.slice(-6).join(" ");
  for (const [yes, no] of CONTRADICTION_PAIRS) {
    if (recent.includes(yes) && line.includes(no)) return `${yes}→${no}`;
    if (recent.includes(no) && line.includes(yes)) return `${no}→${yes}`;
  }
  return undefined;
}
