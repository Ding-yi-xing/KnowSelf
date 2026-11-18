/**
 * 「我是谁」的身份锚。
 *
 * 背景事故：杨子杰说「我当时已经毕业了啊」（说他自己），紧接着问「那你现在在哪个学校？」，
 * 代理回了一句「哪个学校 我早不读了 你这话问得跟我还在念书似的」——
 * 既把**对方**的毕业安到了自己头上，也否认了自己在读。
 *
 * 根因之一是回复 prompt 里**根本没有「我是谁」**：只有「你就是用户本人」这句空话，
 * 学校、年级、在读状态一个都没有，模型只能从聊天里的「下班」「毕业」去猜。
 *
 * 这里从画像卡片里抽一条**简短、可注入、不含隐私**的身份口径。
 *
 * @module @knowself/dsh-plugin/reply-identity
 */

/** 允许作为身份口径的 section 标题关键词（按优先级）。 */
const IDENTITY_SECTION_MARKERS = ["身份口径", "身份认知", "身份/角色", "基本信息"];
/** 兜底：教育背景那一节。 */
const EDUCATION_SECTION_MARKERS = ["教育背景", "学业", "学习经历"];

/** 含这些词的 section 不进 prompt：身份锚只需要「是谁」，不需要联系方式。 */
const PRIVACY_HINT = /(电话|手机号|邮箱|身份证|密码|住址|具体地址|银行卡)/;
/**
 * 元描述：这些 section 在讲「系统/画像怎么描述用户」，不是「我是谁」。
 * 真实坑：identity 里的「身份认知」写的是「用户已知晓系统对自身身份的描述为…」，
 * 按优先级抽出来注入 prompt 会让模型看到第三人称的元叙述。
 */
const META_DESCRIPTION_HINT = /(^\s*用户|系统对|模型对|画像|需要明确回答口径|避免模型)/;

export interface IdentityCardLike {
  key: string;
  sections: Array<{ title: string; body: string }>;
}

/** 取第一句，压到 `limit` 字以内，去掉句末标点。 */
function firstSentence(body: string, limit: number): string {
  const cleaned = body.replace(/\s+/g, " ").trim();
  const cut = cleaned.split(/[。；;！!？?]/)[0]?.trim() ?? cleaned;
  const text = cut === "" ? cleaned : cut;
  return text.slice(0, limit);
}

function findSection(cards: readonly IdentityCardLike[], cardKey: string, markers: readonly string[]): string | null {
  const card = cards.find((item) => item.key === cardKey);
  if (card === undefined) return null;
  for (const marker of markers) {
    const hit = card.sections.find((section) => section.title.includes(marker));
    if (hit === undefined || hit.body.trim() === "") continue;
    if (PRIVACY_HINT.test(hit.body)) continue;
    // 元描述（「用户已知晓…」「系统对…」）不是身份口径，跳过继续找下一个候选。
    if (META_DESCRIPTION_HINT.test(hit.body)) continue;
    return firstSentence(hit.body, 90);
  }
  return null;
}

/**
 * 抽一条身份口径。
 *
 * 优先级：identity 卡片里的「身份口径 / 身份认知 / 身份角色」→ education 的「教育背景」。
 * 都取不到返回 null（调用方就不注入身份块，而不是编一条）。
 */
export function pickIdentityLine(cards: readonly IdentityCardLike[]): string | null {
  return findSection(cards, "identity", IDENTITY_SECTION_MARKERS)
    ?? findSection(cards, "education", EDUCATION_SECTION_MARKERS);
}
