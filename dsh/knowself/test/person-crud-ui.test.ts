// @vitest-environment jsdom
/**
 * W-3 批次 1：人物**写操作**的前端交互测试（jsdom + testing-library）。
 *
 * ## 为什么必须测"请求体"
 * 写操作最容易错的地方不是按钮点不到，而是**发出去的字段名/值不对**
 * （`display_name` vs `name`、`target_person_id` vs `target`）。后端会回 400/404，
 * 但那时已经晚了一步。这两条用例把"点完发了什么"钉死，并顺带验证刷新后的显示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PersonPanelView } from "../src/client/person-panel.js";
import type { PersonPanelDataPort, PersonPanelRow } from "../src/client/data-port.js";
import type { PersonWritePort } from "../src/client/person-write-port.js";

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 一行人物桩。 */
function row(personId: string, displayName: string, msgCount = 3): PersonPanelRow {
  return {
    person_id: personId,
    subject_kind: "contact",
    display_name: displayName,
    remark: "",
    sort_key: "",
    avatar_ref: null,
    status: "active",
    merged_into: null,
    first_msg_at: null,
    last_msg_at: null,
    msg_count: msgCount,
    conv_count: 1,
    profile_json: "{}",
    manual_locked: false,
    created_at: "2026-11-20T00:00:00.000Z",
    updated_at: "2026-11-20T00:00:00.000Z",
  };
}

/**
 * 造一个会"记住写入"的读端口：调用 updatePerson 后 `listPersons` 返回新名字，
 * 这样能断言"刷新后的显示"，而不只是"函数被调用了"。
 */
function makePorts(): {
  port: PersonPanelDataPort;
  writePort: PersonWritePort;
  updatePerson: ReturnType<typeof vi.fn>;
  mergePerson: ReturnType<typeof vi.fn>;
} {
  let people: PersonPanelRow[] = [row("p-a", "张三"), row("p-b", "李四（备注）", 7)];

  const updatePerson = vi.fn(async (personId: string, patch: { display_name?: string }) => {
    people = people.map((person) =>
      person.person_id === personId
        ? { ...person, display_name: patch.display_name ?? person.display_name }
        : person,
    );
    return people.find((person) => person.person_id === personId) as PersonPanelRow;
  });
  const mergePerson = vi.fn(async (personId: string, targetPersonId: string) => ({
    from: people.find((person) => person.person_id === personId) as PersonPanelRow,
    to: people.find((person) => person.person_id === targetPersonId) as PersonPanelRow,
    moved_aliases: 1,
    dropped_duplicate_aliases: 0,
  }));

  const port = {
    listPersons: async (q?: { keyword?: string }) => {
      if (q?.keyword !== undefined && q.keyword !== "") {
        return people.filter((person) => person.display_name.includes(q.keyword as string));
      }
      return people;
    },
    getPerson: async (personId: string) => people.find((person) => person.person_id === personId) ?? null,
    timeline: async () => [],
  } as unknown as PersonPanelDataPort;

  const writePort = {
    runMining: vi.fn(async () => {}),
    createPerson: vi.fn(),
    updatePerson,
    mergePerson,
    archivePerson: vi.fn(async (personId: string) => people.find((p) => p.person_id === personId) as PersonPanelRow),
  } as unknown as PersonWritePort;

  return { port, writePort, updatePerson, mergePerson };
}

describe("W-3 人物写操作（前端）", () => {
  it("改名：发送 {display_name} 且刷新后显示新名字", async () => {
    const { port, writePort, updatePerson } = makePorts();
    render(createElement(PersonPanelView, { port, bridgeReady: true, writePort }));

    // 选中「张三」
    await waitFor(() => expect(screen.getAllByText("张三").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("张三")[0] as HTMLElement);

    await waitFor(() => expect(screen.getByTestId("person-name-input")).toBeDefined());
    fireEvent.change(screen.getByTestId("person-name-input"), { target: { value: "张三丰" } });
    fireEvent.click(screen.getByTestId("person-rename"));

    await waitFor(() => expect(updatePerson).toHaveBeenCalledTimes(1));
    expect(updatePerson).toHaveBeenCalledWith("p-a", { display_name: "张三丰" });
    // 刷新后列表里出现新名字（读端口被重新调用）
    await waitFor(() => expect(screen.getAllByText("张三丰").length).toBeGreaterThan(0));
  });

  it("改名成功且后端排了刷新 → 显示「正在刷新图谱」", async () => {
    const { port, writePort } = makePorts();
    // 让 updatePerson 带回 graph_refresh（模拟后端改名路径）
    (writePort.updatePerson as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (personId: string, patch: { display_name?: string }) => ({
        ...row(personId, patch.display_name ?? "张三"),
        graph_refresh: { scheduled: true, debounce_ms: 5000 },
      }),
    );
    render(createElement(PersonPanelView, { port, bridgeReady: true, writePort }));

    await waitFor(() => expect(screen.getAllByText("张三").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("张三")[0] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("person-name-input")).toBeDefined());
    fireEvent.change(screen.getByTestId("person-name-input"), { target: { value: "张三丰" } });
    fireEvent.click(screen.getByTestId("person-rename"));

    await waitFor(() => expect(screen.getByTestId("graph-refreshing")).toBeDefined());
    expect(screen.getByTestId("graph-refreshing").textContent).toContain("正在刷新图谱");
    // 同时给出手动出口
    expect(screen.getByTestId("graph-refresh-retry")).toBeDefined();
  });

  it("手动刷新失败 → 显示「图谱刷新失败，可手动重试」且带原因", async () => {
    const { port, writePort } = makePorts();
    (writePort.runMining as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("POST /mining-run → 500（mining_failed）"),
    );
    (writePort.updatePerson as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (personId: string, patch: { display_name?: string }) => ({
        ...row(personId, patch.display_name ?? "张三"),
        graph_refresh: { scheduled: true, debounce_ms: 5000 },
      }),
    );
    render(createElement(PersonPanelView, { port, bridgeReady: true, writePort }));

    await waitFor(() => expect(screen.getAllByText("张三").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("张三")[0] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("person-name-input")).toBeDefined());
    fireEvent.change(screen.getByTestId("person-name-input"), { target: { value: "张三丰" } });
    fireEvent.click(screen.getByTestId("person-rename"));
    await waitFor(() => expect(screen.getByTestId("graph-refresh-retry")).toBeDefined());

    fireEvent.click(screen.getByTestId("graph-refresh-retry"));
    await waitFor(() => expect(screen.getByTestId("graph-refresh-failed")).toBeDefined());
    expect(screen.getByTestId("graph-refresh-failed").textContent).toContain("图谱刷新失败");
    expect(screen.getByTestId("graph-refresh-failed").textContent).toContain("mining_failed");
  });

  it("合并：搜索→选中→确认，发送 {target_person_id}", async () => {
    const { port, writePort, mergePerson } = makePorts();
    render(createElement(PersonPanelView, { port, bridgeReady: true, writePort }));

    await waitFor(() => expect(screen.getAllByText("张三").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("张三")[0] as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("person-merge")).toBeDefined());

    fireEvent.click(screen.getByTestId("person-merge"));
    fireEvent.change(screen.getByTestId("person-merge-search"), { target: { value: "李四" } });

    await waitFor(() => expect(screen.getByTestId("person-merge-candidate-p-b")).toBeDefined());
    fireEvent.click(screen.getByTestId("person-merge-candidate-p-b"));
    // 二次确认必须给出后果文案（消息条数 + 不可撤销）
    expect(screen.getByTestId("person-merge-consequence").textContent).toContain("3 条消息");

    fireEvent.click(screen.getByTestId("person-merge-confirm"));
    await waitFor(() => expect(mergePerson).toHaveBeenCalledTimes(1));
    expect(mergePerson).toHaveBeenCalledWith("p-a", "p-b", "manual-merge");
  });
});
