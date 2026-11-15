import { describe, it, expect, vi } from "vitest";
import { createSource } from "../src/intake";
import type { ProfileStore } from "@knowself/profile-store";
import type { ToolRegistry } from "@knowself/mcp-host";
import type { CreateSourceRequest, SourceStored } from "@knowself/contracts";

const { recognizeMock } = vi.hoisted(() => ({
  recognizeMock: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  default: {
    recognize: recognizeMock,
  },
}));

function mockStore(): ProfileStore {
  const sources: SourceStored[] = [];
  return {
    core: {} as any,
    cards: {} as any,
    journal: {} as any,
    sources: {
      list: vi.fn(() => ({ items: [], total: 0 })),
      get: vi.fn(() => sources[0]),
      findByIdempotencyKey: vi.fn((key: string) => sources.find((s) => s.idempotency_key === key)),
      insert: vi.fn((s: SourceStored) => {
        sources.push(s);
      }),
      updateStatus: vi.fn(),
      updateNote: vi.fn(),
      delete: vi.fn(),
    },
    proposals: {} as any,
    links: {} as any,
    events: {} as any,
    write: vi.fn(),
    exportProfile: vi.fn() as any,
    close: vi.fn(),
  };
}

function mockToolRegistry(): ToolRegistry {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    invoke: vi.fn(() =>
      Promise.resolve({
        tool_use_id: "t1",
        name: "fetch__fetch",
        is_error: false,
        output: JSON.stringify({
          text: "<html><body><h1>Test</h1><p>Hello world</p></body></html>",
          contentType: "text/html",
        }),
        error_code: null,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 10,
        source_id: "fetch",
      }),
    ),
    onChange: vi.fn(() => vi.fn()),
    mergeFromSource: vi.fn(),
    registerClient: vi.fn(),
    getClient: vi.fn(() => undefined),
  };
}

describe("createSource — kind=file", () => {
  it("creates a SourceStored from a .md file buffer", async () => {
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    };

    const req: CreateSourceRequest & { kind: "file" } = {
      kind: "file",
      original_name: "notes.md",
      mime_type: "text/markdown",
      user_note: "",
      user_tags: [],
    };

    const bytes = Buffer.from("# hello\n\nworld", "utf-8");
    const result = await createSource(deps, req, bytes);

    expect(result.kind).toBe("file");
    expect(result.mime_type).toBe("text/markdown");
    expect(result.original_name).toBe("notes.md");
    expect(result.extracted_text).toContain("hello");
    expect(result.status).toBe("raw");
    expect(result.file_path).toBeTruthy();
  });

  it("rejects empty buffer", async () => {
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
    };

    const req: CreateSourceRequest & { kind: "file" } = {
      kind: "file",
      original_name: "empty.txt",
      mime_type: "text/plain",
      user_note: "",
      user_tags: [],
    };

    await expect(createSource(deps, req, Buffer.alloc(0))).rejects.toThrow();
  });

  it("creates a SourceStored from an image file buffer", async () => {
    recognizeMock.mockResolvedValue({
      data: {
        text: "跑步 读书 旅行",
        confidence: 88,
      },
    });
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    };

    const req: CreateSourceRequest & { kind: "file" } = {
      kind: "file",
      original_name: "vision-board.png",
      mime_type: "image/png",
      user_note: "这是我的目标板图片，里面有跑步、读书和旅行。",
      user_tags: [],
    };

    const result = await createSource(deps, req, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    expect(result.kind).toBe("file");
    expect(result.mime_type).toBe("image/png");
    expect(result.original_name).toBe("vision-board.png");
    expect(result.extracted_text).toContain("图片资料");
    expect(result.extracted_text).toContain("跑步 读书 旅行");
    expect(result.user_note).toContain("目标板图片");
    expect(result.file_path).toMatch(/\.png$/);
  });
});

describe("createSource — kind=paste", () => {
  it("creates a SourceStored from pasted text", async () => {
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    };

    const req: CreateSourceRequest & { kind: "paste" } = {
      kind: "paste",
      text: "Some pasted text content",
      original_name: "pasted note",
      user_note: "",
      user_tags: [],
    };

    const result = await createSource(deps, req);

    expect(result.kind).toBe("paste");
    expect(result.mime_type).toBe("text/plain");
    expect(result.extracted_text).toBe("Some pasted text content");
    expect(result.file_path).toBeNull();
  });

  it("reuses the existing Source for a repeated idempotency key", async () => {
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    };
    const req: CreateSourceRequest & { kind: "paste" } = {
      kind: "paste",
      idempotency_key: "dsh-session:session-1:7",
      text: "same source",
      original_name: "session turn",
      user_note: "",
      user_tags: [],
    };

    const first = await createSource(deps, req);
    const second = await createSource(deps, req);

    expect(second.id).toBe(first.id);
    expect(store.sources.insert).toHaveBeenCalledTimes(1);
  });
});

describe("createSource — kind=url", () => {
  it("fetches URL and creates a SourceStored", async () => {
    const store = mockStore();
    const deps = {
      store,
      toolRegistry: mockToolRegistry(),
      sourcesDir: "/tmp/test-sources",
      conversationId: "00000000-0000-0000-0000-000000000001",
      now: () => "2026-01-01T00:00:00.000Z",
    };

    const req: CreateSourceRequest & { kind: "url" } = {
      kind: "url",
      url: "https://example.com/article",
      user_note: "",
      user_tags: [],
    };

    const result = await createSource(deps, req);

    expect(result.kind).toBe("url");
    expect(result.url).toBe("https://example.com/article");
    expect(result.extracted_text).toContain("Hello world");
  });
});
