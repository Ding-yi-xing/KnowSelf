/**
 * JournalPage — L3 日记。日期列表 + 当日记录 + 追加。
 */
import { useEffect, useState, useCallback, useMemo, type FormEvent } from "react";
import { CalendarDays, Plus, Tag } from "lucide-react";
import { useProfileStore } from "../stores/profile";
import { useTransport } from "../stores/transport-context";
import type { JournalDate } from "@knowself/contracts";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/spinner";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";

export function JournalPage() {
  const t = useT();
  const transport = useTransport();
  const journalsMap = useProfileStore((s) => s.journals);
  const loading = useProfileStore((s) => s.loading);
  const loadJournalList = useProfileStore((s) => s.loadJournalList);
  const loadJournal = useProfileStore((s) => s.loadJournal);
  const appendJournal = useProfileStore((s) => s.appendJournal);

  const [selectedDate, setSelectedDate] = useState<JournalDate | null>(null);
  const [newEntry, setNewEntry] = useState("");
  const [tags, setTags] = useState("");
  const [showTags, setShowTags] = useState(false);

  const journalEntries = useMemo(
    () =>
      Array.from(journalsMap.values())
        .map((e) => e.summary)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [journalsMap],
  );

  const selectedFull = selectedDate ? journalsMap.get(selectedDate)?.full : null;

  useEffect(() => {
    void loadJournalList(transport);
  }, [loadJournalList, transport]);

  const handleSelectDate = useCallback(
    async (date: JournalDate) => {
      setSelectedDate(date);
      await loadJournal(date, transport);
    },
    [loadJournal, transport],
  );

  const handleAppend = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!selectedDate || !newEntry.trim()) return;
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await appendJournal(
        selectedDate,
        newEntry.trim(),
        tagList.length > 0 ? tagList : undefined,
        transport,
      );
      setNewEntry("");
      setTags("");
      await loadJournal(selectedDate, transport);
    },
    [selectedDate, newEntry, tags, appendJournal, loadJournal, transport],
  );

  const handleNewToday = useCallback(() => {
    const today: JournalDate = new Date().toISOString().slice(0, 10);
    void handleSelectDate(today);
  }, [handleSelectDate]);

  if (loading && journalsMap.size === 0)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("journal.title")}
        subtitle={t("journal.subtitle")}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={handleNewToday}
            iconLeft={<Plus className="size-3.5" strokeWidth={2.4} />}
          >
            {t("journal.today")}
          </Button>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        <aside
          className={cn(
            "flex w-60 shrink-0 flex-col overflow-hidden",
            "border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
          )}
        >
          <div className="flex-1 overflow-y-auto p-3">
            {journalEntries.length === 0 ? (
              <EmptyState
                compact
                icon={<CalendarDays className="size-5" strokeWidth={1.8} />}
                title={t("journal.empty.title")}
                description={t("journal.empty.desc")}
              />
            ) : (
              <ul className="space-y-0.5">
                {journalEntries.map((d) => {
                  const active = selectedDate === d.date;
                  return (
                    <li key={d.date}>
                      <button
                        type="button"
                        onClick={() => void handleSelectDate(d.date)}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] px-3 py-1.5",
                          "transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                          active
                            ? "bg-[var(--color-bg)] shadow-[var(--shadow-xs)]"
                            : "hover:bg-[var(--color-bg)]",
                        )}
                      >
                        <span className="font-mono text-[13px] tracking-[-0.005em] text-[var(--color-fg)]">
                          {d.date}
                        </span>
                        <Badge variant="default" className="font-mono">
                          {d.record_count}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <section className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl p-8">
              {selectedDate ? (
                !selectedFull || selectedFull.records.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<CalendarDays className="size-5" strokeWidth={1.8} />}
                    title={t("journal.empty.date", { d: selectedDate })}
                    description={t("journal.empty.date_desc")}
                  />
                ) : (
                  <div className="space-y-4">
                    <div className="mb-2 flex items-baseline gap-3">
                      <h2 className="font-mono text-[22px] font-semibold tracking-[-0.01em] text-[var(--color-fg)]">
                        {selectedDate}
                      </h2>
                      <span className="text-[12px] text-[var(--color-fg-subtle)]">
                        {t("journal.count", { n: String(selectedFull.records.length) })}
                      </span>
                    </div>
                    {selectedFull.records.map((r) => (
                      <Card key={r.id} className="space-y-2 fade-in">
                        <p className="whitespace-pre-wrap text-[14.5px] leading-[1.65] text-[var(--color-fg)]">
                          {r.body}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border-subtle)] pt-2">
                          <span className="font-mono text-[11.5px] text-[var(--color-fg-subtle)]">
                            {new Date(r.recorded_at).toLocaleTimeString("zh-CN", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {r.tags.map((t) => (
                            <Badge key={t} variant="outline">
                              #{t}
                            </Badge>
                          ))}
                        </div>
                      </Card>
                    ))}
                  </div>
                )
              ) : (
                <div className="flex h-[calc(100vh-12rem)] items-center justify-center">
                  <EmptyState
                    icon={<CalendarDays className="size-6" strokeWidth={1.8} />}
                    title={t("journal.select_date")}
                    description={t("journal.select_date_desc")}
                  />
                </div>
              )}
            </div>
          </div>

          {selectedDate && (
            <form
              onSubmit={(e) => void handleAppend(e)}
              className="shrink-0 border-t border-[var(--color-border-subtle)] bg-[var(--color-bg)] p-4"
            >
              <div className="mx-auto max-w-3xl space-y-2">
                <Textarea
                  value={newEntry}
                  onChange={(e) => setNewEntry(e.target.value)}
                  placeholder={t("journal.placeholder")}
                  rows={3}
                />
                <div className="flex items-center gap-2">
                  {showTags && (
                    <Input
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                      placeholder={t("journal.tags_placeholder")}
                      className="h-8 flex-1 text-[13px]"
                    />
                  )}
                  {!showTags ? (
                    <Button
                      type="button"
                      variant="subtle"
                      size="sm"
                      onClick={() => setShowTags(true)}
                      iconLeft={<Tag className="size-3.5" strokeWidth={2} />}
                    >
                      {t("journal.add_tag")}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowTags(false)}
                    >
                      {t("journal.hide_tags")}
                    </Button>
                  )}
                  <Button type="submit" variant="primary" size="sm" disabled={!newEntry.trim()}>
                    {t("journal.append")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
