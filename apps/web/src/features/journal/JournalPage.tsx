/**
 * JournalPage — L3 日志。
 * 迁移前行为：日期列表（倒序）、选中读当日记录、追加记录（正文 + 逗号分隔标签）、空态与 Toast。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { profileApi, type ProfileApi } from "../../transport/profileApi";
import type { JournalDateSummary, JournalRecord } from "../../transport/types";
import { Badge, Button, Card, EmptyState, ErrorBanner, PageHeader, Spinner, Toast } from "../../ui/primitives";

export function JournalPage({ client = profileApi }: { client?: ProfileApi }) {
  const [dates, setDates] = useState<JournalDateSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [records, setRecords] = useState<readonly JournalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const list = await client.listJournalDates();
      setDates([...list].sort((a, b) => b.date.localeCompare(a.date)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  const select = useCallback(async (date: string) => {
    setSelected(date);
    try {
      const entry = await client.getJournal(date);
      setRecords(entry.records);
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : "读取日志失败");
      setRecords([]);
    }
  }, [client, notify]);

  return (
    <div className="content-inner">
      <PageHeader title="日志" subtitle="按日期浏览与追加记录。" />
      {error !== null && <ErrorBanner message={error} />}

      {loading && dates.length === 0 ? <Spinner label="加载日志" /> : (
        <div className="master-detail">
          <div className="master-list">
            {dates.length === 0 ? (
              <div className="card-meta" style={{ padding: 12 }}>暂无日志</div>
            ) : dates.map((item) => (
              <button
                key={item.date}
                className="master-item"
                data-active={item.date === selected}
                onClick={() => void select(item.date)}
              >
                <strong>{item.date}</strong>
                <span className="card-meta">{item.record_count} 条记录</span>
              </button>
            ))}
          </div>

          <div className="detail">
            {selected === null ? (
              <EmptyState title="选择日期" description="左侧选择日期查看当日记录。" />
            ) : (
              <>
                <Card>
                  <div className="card-head">
                    <strong>{selected}</strong>
                    <Badge>{records.length} 条</Badge>
                  </div>
                  {records.length === 0 ? (
                    <div className="card-meta">当日暂无记录</div>
                  ) : records.map((record) => (
                    <div className="card-excerpt" key={record.id}>
                      <div className="card-meta">#{record.ordinal} · {record.recorded_at}</div>
                      {record.body}
                      {record.tags.length > 0 && (
                        <div className="card-actions" style={{ marginTop: 6 }}>
                          {record.tags.map((tag) => <Badge key={tag} tone="info">{tag}</Badge>)}
                        </div>
                      )}
                    </div>
                  ))}
                </Card>
                <AppendForm
                  client={client}
                  date={selected}
                  onAppended={async () => { await select(selected); await loadList(); }}
                  onNotify={notify}
                />
              </>
            )}
          </div>
        </div>
      )}
      {toast !== null && <Toast message={toast} />}
    </div>
  );
}

function AppendForm({
  client, date, onAppended, onNotify,
}: {
  client: ProfileApi;
  date: string;
  onAppended: () => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!body.trim()) { onNotify("正文不能为空"); return; }
    const tagList = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    setBusy(true);
    try {
      await client.appendJournal(date, body.trim(), tagList);
      setBody("");
      setTags("");
      onNotify("已追加");
      await onAppended();
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : "追加失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="group-title">追加记录</h2>
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="日志正文" placeholder="记录内容…" />
      <input className="textarea form-input" style={{ marginTop: 8 }} value={tags} onChange={(e) => setTags(e.target.value)} aria-label="日志标签" placeholder="标签，逗号分隔（可选）" />
      <div className="card-actions" style={{ marginTop: 10 }}>
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>追加</Button>
      </div>
    </Card>
  );
}
