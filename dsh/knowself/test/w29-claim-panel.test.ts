// @vitest-environment jsdom
/**
 * W29 B2：认领面板（`src/client/graph-claim-panel.tsx`）的组件级测试。
 *
 * 说明：`w29-person-claim.test.ts` 是 `@vitest-environment node`（真实 sqlite + dispatch），
 * 无法渲染 React；面板是纯 React 组件，故单独放这个 jsdom 文件（渲染方式与
 * `m3b-client.test.ts` 一致：createElement + @testing-library/react，不引新依赖）。
 *
 * 覆盖（三处固定 testid：claim-person-input / claim-person-error / claim-person-submit）：
 *   A. 空输入提交 → `请输入这个人的名字`，端口 claimPerson **不被调用**；
 *   B. 非法名：纯空白被客户端拦截（不调端口）；超 40 字转发端口，端口拒绝 → 面板显示错误；
 *   C. 成功 → 端口收到 `{ sender_ref, display_name(trim) }`，面板收起（onDone 调用、onCancel 未调用）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GraphClaimPanel } from "../src/client/graph-claim-panel.js";
import type { PersonClaimResult, PersonWritePort } from "../src/client/person-write-port.js";

type ClaimFn = PersonWritePort["claimPerson"];

function okResult(): PersonClaimResult {
  return {
    person_id: "P-1",
    display_name: "黄sir",
    alias: { platform: "wechat", kind: "platform_uid", alias: "uid-abc" },
  };
}

/** 渲染认领面板（固定 senderRef/nodeLabel），回传端口桩与回调 spy。 */
function setup(claimPerson: ClaimFn) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    createElement(GraphClaimPanel, {
      claimPort: { claimPerson },
      nodeLabel: "未识别·1234",
      senderRef: "wechat:uid-abc",
      onDone,
      onCancel,
    }),
  );
  return { claimPerson, onDone, onCancel };
}

const input = (): HTMLInputElement => screen.getByTestId("claim-person-input") as HTMLInputElement;
const submit = (): void => {
  fireEvent.click(screen.getByTestId("claim-person-submit"));
};

afterEach(() => cleanup());

describe("W29 B2 认领面板：输入校验 / 提交 / 收起", () => {
  it("A. 空输入提交 → claim-person-error 文案，且 claimPerson 未被调用", async () => {
    const claimPerson = vi.fn<ClaimFn>(async () => okResult());
    const { onDone } = setup(claimPerson);

    submit();

    await waitFor(() =>
      expect(screen.getByTestId("claim-person-error").textContent).toContain("请输入这个人的名字"),
    );
    expect(claimPerson).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("B. 非法名：纯空白被拦截不调端口；超 40 字转发端口、端口拒绝后显示错误", async () => {
    const claimPerson = vi.fn<ClaimFn>(async () => {
      throw new Error("名字最多 40 个字");
    });
    setup(claimPerson);

    // 纯空白 → 客户端拦截（trim 后为空）
    fireEvent.change(input(), { target: { value: "   " } });
    submit();
    await waitFor(() =>
      expect(screen.getByTestId("claim-person-error").textContent).toContain("请输入这个人的名字"),
    );
    expect(claimPerson).not.toHaveBeenCalled();

    // 超 40 字 → 面板不预校验长度，转发给端口（真实后端按 400 拒绝）；面板显示端口错误
    const longName = "名".repeat(41);
    fireEvent.change(input(), { target: { value: longName } });
    submit();
    await waitFor(() =>
      expect(screen.getByTestId("claim-person-error").textContent).toContain("名字最多 40 个字"),
    );
    expect(claimPerson).toHaveBeenCalledTimes(1);
    expect(claimPerson).toHaveBeenCalledWith({ sender_ref: "wechat:uid-abc", display_name: longName });
  });

  it("C. 成功 → 端口收到 { sender_ref, display_name(trim) }，面板收起（onDone 调用、onCancel 未调用）", async () => {
    const claimPerson = vi.fn<ClaimFn>(async () => okResult());
    const { onDone, onCancel } = setup(claimPerson);

    fireEvent.change(input(), { target: { value: "  黄sir  " } });
    submit();

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // 提交前 trim 掉首尾空格
    expect(claimPerson).toHaveBeenCalledWith({ sender_ref: "wechat:uid-abc", display_name: "黄sir" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
