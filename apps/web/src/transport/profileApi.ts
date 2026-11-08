/**
 * 画像 / 系统 / 模板 REST 传输层 —— 新壳重写，零复用旧前端 transport。
 * 端点与迁移前一致；写入统一走 `WriteRequestSchema`（provenance: "user"）。
 */
import type {
  CardSummary,
  CardWithSections,
  JournalDateSummary,
  JournalEntryStored,
  SystemStatus,
  TemplateRecord,
} from "./types";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`${method} ${path} → ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface ProfileApi {
  systemStatus(): Promise<SystemStatus>;
  listTemplates(): Promise<TemplateRecord[]>;
  createTemplate(body: Omit<TemplateRecord, "created_at">): Promise<TemplateRecord>;
  deleteTemplate(id: string): Promise<void>;
  listCards(): Promise<CardSummary[]>;
  getCard(key: string): Promise<CardWithSections>;
  saveCard(key: string, body: Record<string, unknown>): Promise<void>;
  deleteCard(key: string): Promise<void>;
  listJournalDates(): Promise<JournalDateSummary[]>;
  getJournal(date: string): Promise<JournalEntryStored>;
  appendJournal(date: string, body: string, tags: readonly string[]): Promise<void>;
}

export const profileApi: ProfileApi = {
  systemStatus: () => request<SystemStatus>("GET", "/api/system/status"),
  listTemplates: () => request<TemplateRecord[]>("GET", "/api/templates"),
  createTemplate: (body) =>
    request<TemplateRecord>("POST", "/api/templates", body),
  deleteTemplate: (id) => request<void>("DELETE", `/api/templates/${encodeURIComponent(id)}`),
  listCards: () => request<CardSummary[]>("GET", "/api/profile/cards"),
  getCard: (key) => request<CardWithSections>("GET", `/api/profile/cards/${encodeURIComponent(key)}`),
  saveCard: (key, body) =>
    request<void>("PUT", `/api/profile/cards/${encodeURIComponent(key)}`, {
      target: "card",
      key,
      provenance: "user",
      ...body,
    }),
  deleteCard: (key) => request<void>("DELETE", `/api/profile/cards/${encodeURIComponent(key)}`),
  listJournalDates: () => request<JournalDateSummary[]>("GET", "/api/profile/journal"),
  getJournal: (date) => request<JournalEntryStored>("GET", `/api/profile/journal/${encodeURIComponent(date)}`),
  appendJournal: (date, body, tags) =>
    request<void>("POST", "/api/profile/journal", {
      target: "journal",
      date,
      body,
      tags: [...tags],
      provenance: "user",
    }),
};
