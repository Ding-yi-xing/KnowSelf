/**
 * CardsPage — L2 卡片 master-detail。
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import { Plus, Layers, Pencil } from "lucide-react";
import type { CardKey, CardStored } from "@knowself/contracts";
import { useProfileStore } from "../stores/profile";
import { useTransport } from "../stores/transport-context";
import { CardEditor } from "../components/CardEditor";
import { PageHeader } from "../components/ui/page-header";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/spinner";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";

export function CardsPage() {
  const t = useT();
  const transport = useTransport();
  const cardsMap = useProfileStore((s) => s.cards);
  const loading = useProfileStore((s) => s.loading);
  const saveCard = useProfileStore((s) => s.saveCard);
  const loadCard = useProfileStore((s) => s.loadCard);
  const loadCardList = useProfileStore((s) => s.loadCardList);

  const [selectedKey, setSelectedKey] = useState<CardKey | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadCardList(transport);
  }, [loadCardList, transport]);

  const cards = useMemo(() => Array.from(cardsMap.values()).map((e) => e.summary), [cardsMap]);

  const selectedFull = (selectedKey ? cardsMap.get(selectedKey)?.full : null) ?? null;

  const handleSelect = useCallback(
    (key: CardKey) => {
      setSelectedKey(key);
      setEditing(false);
      void loadCard(key, transport);
    },
    [loadCard, transport],
  );

  const handleNewCard = useCallback(() => {
    setSelectedKey(null);
    setEditing(true);
  }, []);

  const handleSave = useCallback(
    async (data: {
      title: string;
      summary: string;
      sections: { title: string; body: string }[];
    }) => {
      setSaving(true);
      const key: CardKey = selectedKey ?? data.title.toLowerCase().replace(/\s+/g, "_");
      try {
        await saveCard(
          key,
          {
            title: data.title,
            summary: data.summary,
            section_tags: [],
            sections: data.sections.map((s) => ({ title: s.title, body: s.body })),
          },
          transport,
        );
        setEditing(false);
        setSelectedKey(key);
      } finally {
        setSaving(false);
      }
    },
    [selectedKey, saveCard, transport],
  );

  if (loading && cardsMap.size === 0)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="lg" className="text-[var(--color-fg-subtle)]" />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("cards.title")}
        subtitle={t("cards.subtitle")}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={handleNewCard}
            iconLeft={<Plus className="size-3.5" strokeWidth={2.4} />}
          >
            {t("cards.new")}
          </Button>
        }
      />

      <div className="flex flex-1 overflow-hidden">
        {/* 列表 */}
        <aside
          className={cn(
            "flex w-72 shrink-0 flex-col overflow-hidden",
            "border-r border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)]",
          )}
        >
          <div className="flex-1 overflow-y-auto p-3">
            {cards.length === 0 ? (
              <EmptyState
                compact
                icon={<Layers className="size-5" strokeWidth={1.8} />}
                title={t("cards.empty.title")}
                description={t("cards.empty.desc")}
              />
            ) : (
              <ul className="space-y-1">
                {cards.map((c) => {
                  const active = selectedKey === c.key && !editing;
                  return (
                    <li key={c.key}>
                      <button
                        type="button"
                        onClick={() => handleSelect(c.key)}
                        className={cn(
                          "group block w-full rounded-[var(--radius-md)] px-3 py-2 text-left",
                          "transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                          active
                            ? "bg-[var(--color-bg)] shadow-[var(--shadow-xs)]"
                            : "hover:bg-[var(--color-bg)]",
                        )}
                      >
                        <div
                          className={cn(
                            "truncate text-[13.5px] font-medium",
                            active ? "text-[var(--color-fg)]" : "text-[var(--color-fg)]",
                          )}
                        >
                          {c.title}
                        </div>
                        <div className="mt-0.5 truncate text-[12px] text-[var(--color-fg-muted)]">
                          {c.summary}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 详情 / 编辑器 */}
        <section className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-8">
            {editing ? (
              <CardEditor
                initial={selectedKey ? selectedFull : null}
                onSave={(d) => void handleSave(d)}
                onCancel={() => setEditing(false)}
                saving={saving}
              />
            ) : selectedKey && selectedFull ? (
              <CardDetail card={selectedFull} onEdit={() => setEditing(true)} />
            ) : (
              <div className="flex h-[calc(100vh-12rem)] items-center justify-center">
                <EmptyState
                  icon={<Layers className="size-6" strokeWidth={1.8} />}
                  title={cards.length === 0 ? t("cards.empty.title") : t("cards.empty.select")}
                  description={
                    cards.length === 0 ? t("cards.empty.start") : t("cards.empty.detail")
                  }
                  action={
                    cards.length === 0 ? (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleNewCard}
                        iconLeft={<Plus className="size-3.5" strokeWidth={2.4} />}
                      >
                        {t("cards.new")}
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function CardDetail({
  card,
  onEdit,
}: {
  card: CardStored & {
    sections?: { title: string; body: string }[];
  };
  onEdit: () => void;
}) {
  const t = useT();
  const sections =
    (
      card as unknown as {
        sections?: { title: string; body: string }[];
      }
    ).sections ?? [];

  return (
    <article className="space-y-6 fade-in">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[28px] font-semibold tracking-[-0.015em] text-[var(--color-fg)]">
            {card.title}
          </h2>
          <p className="mt-1.5 text-[14px] leading-[1.55] text-[var(--color-fg-muted)]">
            {card.summary}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onEdit}
          iconLeft={<Pencil className="size-3.5" strokeWidth={2.2} />}
        >
          {t("cards.edit")}
        </Button>
      </header>

      {sections.length === 0 ? (
        <p className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
          {t("cards.no_sections")}
        </p>
      ) : (
        <div className="space-y-5">
          {sections.map((s, i) => (
            <section key={i}>
              <h3 className="mb-1.5 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-[var(--color-fg-subtle)]">
                {s.title}
              </h3>
              <p className="whitespace-pre-wrap text-[14px] leading-[1.65] text-[var(--color-fg)]">
                {s.body}
              </p>
            </section>
          ))}
        </div>
      )}

      <p className="border-t border-[var(--color-border-subtle)] pt-3 text-[12px] text-[var(--color-fg-subtle)]">
        {t("cards.updated_prefix")}
        {card.updated_at}
      </p>
    </article>
  );
}
