/**
 * 目标人物画像 + 用户口吻画像。
 *
 * 输入是当前会话的受限历史片段（只含角色与正文，不含 key/连接），输出是用于回复生成的
 * 结构化画像。画像只用于当次/当轮生成，不写回人物事实层；失败时返回 null，让 worker
 * 退回「无画像」的普通回复，而不是阻断任务。
 */
import type { ChatChunk, ChatOptions } from "@knowself/contracts";
import { extractEmoji, isRealEmoji, NON_EMOJI_BRACKET } from "./reply-quality.js";

export interface PersonaMessage {
  role: "me" | "them";
  text: string;
  /** 消息时间（epoch ms）；有值时画像能抽出「共同时间线」。 */
  ts_ms?: number;
}

export interface TargetPersona {
  summary: string;
  traits: string[];
  psychology: string[];
  communication: string[];
  taboos: string[];
  relationship: string;
}

/** 用户本人的表情习惯（只统计 role=me 的消息，对方的一律不进）。 */
export interface EmojiProfile {
  /** 带表情的消息占比（0-1）：分子=带表情的我的消息数，分母=我的有效文本消息数。 */
  rate: number;
  /** 我发的表情总个数（一条消息带多个表情会累加）。 */
  total: number;
  /** 进统计的我的有效文本消息数（占位如 [图片]/[语音] 不计入分母）。 */
  messages: number;
  /** 常驻表情库：括号码或 Unicode，按出现次数从高到低。 */
  repertoire: string[];
}

export interface VoiceProfile {
  tone: string;
  length: string;
  habits: string[];
  addressing: string;
  /**
   * 语气词偏好（嗯/哦/噢/哈哈/唉…）。
   * 参考 ex-skill 的 Layer 2：写具体词，不写"随和"这种抽象标签。
   */
  particles?: string[];
  /** 标点与断句习惯（用不用句号 / 空格分句 / 省略号 / 波浪号）。 */
  punctuation?: string;
  /** 消息形态（短句连发 / 长段落 / 语音转文字风格）。 */
  message_format?: string;
  /** 原话示例：从聊天记录里原样截取的「对方一句 → 我一句」，3-5 段。 */
  examples?: string[];
  /** 表情习惯（本地统计，不看模型输出）。 */
  emoji?: EmojiProfile;
}

/** 用户对画像的一条纠正（"不像我""我一般这么说"）。 */
export interface PersonaCorrection {
  layer: string;
  wrong: string;
  right: string;
  at: string;
}

/** 双方重合时间线上的「可回忆区」：只收聊天片段里出现过的，不编。 */
export interface SharedMemory {
  /** 双方确认过的共识事实（职业、学校、共同经历）。 */
  facts: string[];
  /** 共同时线上的关键事件（尽量带日期）。 */
  timeline: string[];
  /** 双方都认识 / 提到过的人（姓名 + 关系）。 */
  people: string[];
}

export interface ReplyPersona {
  target: TargetPersona;
  voice: VoiceProfile;
  /** 共同记忆；旧 payload 没有时为空。 */
  shared?: SharedMemory;
  /** 用户纠正过的语气/说法；有则优先级高于 voice 的同类描述。 */
  corrections?: PersonaCorrection[];
  /** 画像结构版本：改了提取口径就升一级，旧缓存自动失效。 */
  version?: number;
  generated_at: string;
  source_messages: number;
  degraded: boolean;
}

export interface BuildPersonaInput {
  contact_label: string;
  messages: PersonaMessage[];
  provider_id: string;
  model_id: string;
  generate: (options: ChatOptions, signal: AbortSignal) => AsyncIterable<ChatChunk>;
  signal: AbortSignal;
  now?: () => Date;
}

const PERSONA_SCHEMA = `{
  "target": {
    "summary": "一到两句概括对方是什么样的人、你们现在的关系",
    "traits": ["性格关键词，3-6 个"],
    "psychology": ["心理特点/情绪触发点，2-5 条"],
    "communication": ["沟通偏好与有效方式，2-5 条"],
    "taboos": ["雷区/不要说的话，1-4 条"],
    "relationship": "当前关系状态一句话"
  },
  "voice": {
    "tone": "用户本人说话的语气",
    "length": "用户通常的消息长度，如 10-25 字",
    "habits": ["口头禅/表情/标点习惯，2-5 条"],
    "addressing": "用户对对方的称呼方式",
    "particles": ["用户真的会用的语气词，2-5 个，如 嗯/哦/哈哈/唉；没用过就留空数组"],
    "punctuation": "用户的标点与断句习惯，如「几乎不用句号，两句之间用空格」",
    "message_format": "用户的消息形态，如「短句连发」「一条说完」",
    "examples": ["从片段里原样摘的对话，格式：对方：…… / 我：……；摘 3-5 段最能代表说话方式的，不要改写"]
  },
  "shared": {
    "facts": ["双方确认过的共识事实，每条不超过 24 字，最多 6 条；必须附原文依据，格式：事实｜原话：『…』"],
    "timeline": ["共同时线上的关键事件（带日期），每条不超过 24 字，最多 6 条"],
    "people": ["双方都认识或提到过的人（姓名 + 关系），每条不超过 24 字，最多 6 条"]
  }
}`;

function systemPrompt(): string {
  return [
    "你在为“用户本人”做聊天风格、对方心理与双方共同记忆的画像。",
    "只依据给出的聊天片段，不要编造片段中不存在的事实，不要做医学诊断。",
    "shared 只收片段里出现过的人、事、时间；没出现的不要写，宁可少写。",
    "",
    "【最重要：区分「我做过」和「我看到的」】",
    "真实事故：我说过「我建阳税务局招三个人」（在说一条招聘信息），画像却总结成「用户报考建阳税务局」，",
    "回复时又说成「报过啊」和「又没考上」，两级放大，全是编的。",
    "所以：① 只有原文里出现「我报了 / 我考了 / 我去面试了 / 我投了」这类**本人自述动作**，才能写成我的经历；",
    "② 「招三个人 / 有个岗位 / 看到招聘」这类是**信息**，不是我的经历，写事实时必须保留这个区别；",
    "③ facts 每一条都要附原文依据（事实｜原话：『…』），没有原文依据的不要写；",
    "④ 不确定是谁说的、做了什么，就少写或不写——少写不会错，写错会被对方当场戳穿。",
    "",
    "voice 必须写**具体行为**，不要写抽象标签：不要写「幽默」，要写「爱用『行吧』结尾」；",
    "不要写「比较随和」，要写「不同意就说『算了』然后不接话」。",
    "voice.length 按真实消息算（数一下多数消息多少字），不要凭印象；",
    "voice.examples 必须**原样摘抄**片段里的对话，不要改写、不要润色；找不到 3 段就用能找到的段数。",
    "输出必须是严格 JSON，不要 markdown 代码块，不要任何解释。",
    "JSON 结构如下：",
    PERSONA_SCHEMA,
  ].join("\n");
}

/** 把毫秒时间戳压成 `MM-DD`；无效返回空串。 */
function formatDay(tsMs: number | undefined): string {
  if (tsMs === undefined || !Number.isFinite(tsMs) || tsMs <= 0) return "";
  const at = new Date(tsMs);
  return `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

function transcript(messages: PersonaMessage[]): string {
  return messages
    .map((message) => {
      const when = formatDay(message.ts_ms);
      const who = message.role === "me" ? "我" : "对方";
      return `${when === "" ? "" : `[${when}] `}${who}：${message.text.replace(/\s+/g, " ").slice(0, 150)}`;
    })
    .join("\n");
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 6) : [];
}

/**
 * 纯占位消息（[图片]/[语音]/[类型50]/…）：这些不是"文字消息"，不计入表情率的分母。
 * 与 `filterEmoji` 共用同一份占位名单，避免两处口径不一致。
 */
const PLACEHOLDER_MESSAGE = NON_EMOJI_BRACKET;

/** 从我的消息里统计表情习惯：只看 role=me，对方的消息一律不进统计。 */
function emojiProfile(messages: PersonaMessage[]): EmojiProfile {
  const mine = messages.filter(
    (message) => message.role === "me" && message.text.trim() !== "" && !PLACEHOLDER_MESSAGE.test(message.text.trim()),
  );
  if (mine.length < 20) return { rate: 0, total: 0, messages: mine.length, repertoire: [] };
  const counts = new Map<string, number>();
  let withEmoji = 0;
  let total = 0;
  for (const message of mine) {
    const found = extractEmoji(message.text);
    if (found.length > 0) {
      withEmoji += 1;
      total += found.length;
    }
    for (const token of found) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  // 只留用过 ≥2 次的：一次性出现的多半是转述或误判，进库反而会让模型乱用。
  const repertoire = [...counts.entries()]
    .filter(([token]) => isRealEmoji(token))
    .filter(([, times]) => times >= 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([token]) => token);
  return { rate: Math.round((withEmoji / mine.length) * 1000) / 1000, total, messages: mine.length, repertoire };
}

/** 用户自己这条消息有多长：给画像一个实测基准，避免模型把「10-25 字」凭空写进去。 */
function messageLengthStats(messages: PersonaMessage[]): string {
  const lengths = messages
    .filter((message) => message.role === "me")
    .map((message) => message.text.trim().length)
    .filter((value) => value > 0);
  if (lengths.length < 5) return "";
  lengths.sort((left, right) => left - right);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const p90 = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))] ?? median;
  return `实测：你（我）发过 ${lengths.length} 条，中位 ${median} 字，90% 在 ${p90} 字以内。voice.length 必须按这个写，不要凭印象。`;
}

interface ParsedPersona {
  target: TargetPersona;
  voice: VoiceProfile;
  shared: SharedMemory;
}

function parsePersona(raw: string): ParsedPersona | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const target = (parsed.target ?? {}) as Record<string, unknown>;
    const voice = (parsed.voice ?? {}) as Record<string, unknown>;
    const shared = (parsed.shared ?? {}) as Record<string, unknown>;
    return {
      target: {
        summary: asString(target.summary, ""),
        traits: asStringList(target.traits),
        psychology: asStringList(target.psychology),
        communication: asStringList(target.communication),
        taboos: asStringList(target.taboos),
        relationship: asString(target.relationship, ""),
      },
      voice: {
        tone: asString(voice.tone, ""),
        length: asString(voice.length, ""),
        habits: asStringList(voice.habits),
        addressing: asString(voice.addressing, ""),
        particles: asStringList(voice.particles),
        punctuation: asString(voice.punctuation, ""),
        message_format: asString(voice.message_format, ""),
        examples: asStringList(voice.examples),
      },
      shared: {
        facts: asStringList(shared.facts),
        timeline: asStringList(shared.timeline),
        people: asStringList(shared.people),
      },
    };
  } catch {
    return null;
  }
}

/** 画像结构版本：v2 起要求 shared.facts 附原文依据（v1 把「招聘信息」写成了「我报考」）。 */
export const REPLY_PERSONA_VERSION = 2;

export async function buildReplyPersona(input: BuildPersonaInput): Promise<ReplyPersona | null> {
  if (input.messages.length < 4) return null;
  const options: ChatOptions = {
    provider_id: input.provider_id,
    stream: true,
    max_tokens: 4000,
    temperature: 0.2,
    stop_sequences: [],
    tools: [],
    metadata: {},
    messages: [
      { role: "system", content: [{ type: "text", text: systemPrompt() }] },
      {
        role: "user",
        content: [{ type: "text", text: [`联系人：${input.contact_label}`, messageLengthStats(input.messages), `最近聊天片段（越靠后越新）：\n${transcript(input.messages)}`].filter((part) => part !== "").join("\n") }],
      },
    ],
  };
  let raw = "";
  for await (const chunk of input.generate(options, input.signal)) {
    if (input.signal.aborted) return null;
    if (chunk.type === "text") raw += chunk.delta;
    if (chunk.type === "error") return null;
  }
  const parsed = parsePersona(raw);
  const now = input.now ?? (() => new Date());
  // 表情统计只来自 role=me（本人）的消息；对方发的表情一律不进 rate / repertoire。
  const emoji = emojiProfile(input.messages);
  console.info("[knowself] 表情统计（仅本人消息）", {
    myTextMessages: emoji.messages, emojiTotal: emoji.total, rate: emoji.rate, repertoire: emoji.repertoire,
  });
  if (parsed === null) {
    const fallback = raw.trim().slice(0, 400);
    if (fallback === "") return null;
    return {
      target: { summary: fallback, traits: [], psychology: [], communication: [], taboos: [], relationship: "" },
      voice: { tone: "", length: "", habits: [], addressing: "", emoji },
      version: REPLY_PERSONA_VERSION,
      generated_at: now().toISOString(),
      source_messages: input.messages.length,
      degraded: true,
    };
  }
  return {
    target: parsed.target,
    voice: { ...parsed.voice, emoji },
    shared: parsed.shared,
    version: REPLY_PERSONA_VERSION,
    generated_at: now().toISOString(),
    source_messages: input.messages.length,
    degraded: false,
  };
}

/** 把画像压成 system prompt 的一段；空画像返回空串。 */
export function formatPersonaForPrompt(persona: ReplyPersona | null): string {
  if (persona === null) return "";
  const target = persona.target;
  const voice = persona.voice;
  const shared = persona.shared;
  const sharedLines = shared === undefined
    ? []
    : [
        shared.facts.length > 0 ? `共识事实：${shared.facts.join("；")}` : "",
        shared.timeline.length > 0 ? `共同时线：${shared.timeline.join("；")}` : "",
        shared.people.length > 0 ? `共同熟人：${shared.people.join("；")}` : "",
      ].filter((line) => line !== "");
  const sharedBlock = sharedLines.length === 0
    ? ""
    : ["", "共同记忆（双方记录里出现过的；没出现过的不要编）：", ...sharedLines].join("\n");
  const lines = [
    `对方画像（来自聊天记录，仅作参考）：${target.summary}`,
    target.traits.length > 0 ? `性格：${target.traits.join("、")}` : "",
    target.psychology.length > 0 ? `心理特点：${target.psychology.join("；")}` : "",
    target.communication.length > 0 ? `有效沟通方式：${target.communication.join("；")}` : "",
    target.taboos.length > 0 ? `雷区：${target.taboos.join("；")}` : "",
    target.relationship !== "" ? `关系：${target.relationship}` : "",
  ];
  // 口吻区：字段化，避免「要有感情」这种没法执行的描述。
  const voiceLines = [
    voice.tone !== "" || voice.length !== "" ? `语气：${voice.tone}${voice.length ? `（通常 ${voice.length}）` : ""}` : "",
    voice.addressing !== "" ? `称呼：${voice.addressing}` : "",
    (voice.particles ?? []).length > 0 ? `语气词：${(voice.particles ?? []).join("、")}` : "",
    voice.punctuation !== undefined && voice.punctuation !== "" ? `标点/断句：${voice.punctuation}` : "",
    voice.message_format !== undefined && voice.message_format !== "" ? `消息形态：${voice.message_format}` : "",
    voice.habits.length > 0 ? `语言习惯：${voice.habits.join("；")}` : "",
    (voice.emoji?.repertoire ?? []).length === 0
      ? ""
      : `我常用的表情：${(voice.emoji?.repertoire ?? []).join(" ")}（只统计我本人发的消息：${voice.emoji?.messages ?? 0} 条文字里 ${Math.round((voice.emoji?.rate ?? 0) * 100)}% 带表情，共 ${voice.emoji?.total ?? 0} 个）`,
  ].filter((line) => line !== "");
  const voiceBlock = voiceLines.length === 0 ? "" : ["【我平时怎么说话】", ...voiceLines].join("\n");
  const exampleBlock = (voice.examples ?? []).length === 0
    ? ""
    : ["我平时这么说话（原话，照这个来）：", ...(voice.examples ?? []).map((line) => `- ${line}`)].join("\n");
  // 纠正区：用户亲自说过「不像我」之后沉淀下来的，优先级高于模型总结的风格。
  const correctionBlock = (persona.corrections ?? []).length === 0
    ? ""
    : [
        "用户亲自纠正过的（最高优先级，和上面冲突时以这里为准）：",
        ...(persona.corrections ?? []).map((item) => `- 「${item.wrong}」是错的，应该是「${item.right}」`),
      ].join("\n");
  return [lines.filter((line) => line !== "").join("\n"), voiceBlock, exampleBlock, correctionBlock, sharedBlock]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * 把持久化的画像 JSON 反序列化回 `ReplyPersona`；结构不合法返回 null。
 * 用于「任务重启后 6 小时内复用画像，不再重复烧一次模型调用」。
 */
export function deserializeReplyPersona(json: string): ReplyPersona | null {
  try {
    const parsed = JSON.parse(json) as Partial<ReplyPersona> & { degraded?: boolean };
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.generated_at !== "string") return null;
    if (typeof parsed.target !== "object" && parsed.degraded !== true) return null;
    if (typeof parsed.voice !== "object") return null;
    return parsed as ReplyPersona;
  } catch {
    return null;
  }
}
