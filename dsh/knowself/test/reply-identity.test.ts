import { describe, expect, it } from "vitest";
import { pickIdentityLine, type IdentityCardLike } from "../src/reply-identity.js";

function cards(sections: Array<{ title: string; body: string }>, key = "identity"): IdentityCardLike[] {
  return [{ key, sections }];
}

describe("pickIdentityLine", () => {
  it("prefers the explicit identity section", () => {
    const line = pickIdentityLine(cards([
      { title: "性格特质", body: "现实主义倾向明显。" },
      { title: "身份口径", body: "23 岁，泉州师范学院软件工程本科在读，2027 届应届生。也在做个人开发。" },
    ]));
    expect(line).toContain("本科在读");
    expect(line).toContain("2027 届");
    // 只取第一句，避免把整段画像塞进 prompt。
    expect(line).not.toContain("也在做个人开发");
  });

  it("falls back to the education card when identity has no usable section", () => {
    const identityCard: IdentityCardLike = {
      key: "identity",
      sections: [{ title: "性格特质", body: "现实主义。" }],
    };
    const educationCard: IdentityCardLike = {
      key: "education",
      sections: [{ title: "教育背景", body: "泉州师范学院，软件工程专业，本科在读。" }],
    };
    expect(pickIdentityLine([identityCard, educationCard])).toContain("本科在读");
  });

  it("never puts contact details into the prompt", () => {
    // identity 卡片里有手机号和邮箱，身份锚不能把它们带进聊天上下文。
    const line = pickIdentityLine(cards([
      { title: "基本信息", body: "姓名：丁益星；性别：男；联系电话：18900000000；邮箱：a@b.com。" },
    ]));
    expect(line).toBeNull();
  });

  it("skips meta descriptions that talk about the user in third person", () => {
    // identity 里的「身份认知」写的是「用户已知晓系统对自身身份的描述为…」，
    // 这是元叙述，不能当身份口径注入 prompt；应回落到教育背景。
    const identityCard: IdentityCardLike = {
      key: "identity",
      sections: [
        { title: "身份认知", body: "用户已知晓系统对自身身份的描述为'在读学生'，需要明确回答口径，避免模型摇摆。" },
        { title: "身份/角色", body: "用户被亲密关系人称为「还在上学的人」，可能处于学生阶段。" },
      ],
    };
    const educationCard: IdentityCardLike = {
      key: "education",
      sections: [{ title: "教育背景", body: "泉州师范学院，软件工程专业，本科在读。" }],
    };
    const line = pickIdentityLine([identityCard, educationCard]);
    expect(line).toContain("本科在读");
    expect(line).not.toContain("用户");
  });

  it("returns null when there is nothing usable", () => {
    expect(pickIdentityLine([])).toBeNull();
    expect(pickIdentityLine(cards([{ title: "性格特质", body: "现实主义。" }]))).toBeNull();
  });

  it("caps the injected line so the prompt stays small", () => {
    const long = "泉州师范学院软件工程本科在读，".repeat(20);
    const line = pickIdentityLine(cards([{ title: "身份口径", body: long }]));
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(90);
  });
});
