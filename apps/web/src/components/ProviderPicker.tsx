/**
 * ProviderPicker — provider 选择下拉。
 * 视觉：扁平、无强烈边框，与 Composer 工具栏融为一体。
 */
import { ChevronDown } from "lucide-react";
import { useT } from "../lib/i18n";
import { cn } from "../lib/cn";
import { useSettingsStore } from "../stores/settings";

interface ProviderPickerProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ProviderPicker({
  value,
  onChange,
  disabled = false,
  className,
}: ProviderPickerProps) {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const providers = settings?.providers ?? [];
  const isEmpty = providers.length === 0;

  return (
    <div
      className={cn(
        "relative inline-flex items-center",
        disabled && "opacity-50 pointer-events-none",
        className,
      )}
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || isEmpty}
        className={cn(
          "appearance-none rounded-[var(--radius-md)] bg-transparent",
          "py-1.5 pl-2.5 pr-7 text-[12.5px] font-medium text-[var(--color-fg-muted)]",
          "hover:text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]",
          "focus:outline-none focus:bg-[var(--color-bg-muted)]",
          "transition-colors duration-[var(--duration-fast)]",
          "cursor-pointer",
        )}
      >
        {isEmpty && <option value="">{t("provider_picker.none")}</option>}
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 size-3.5 text-[var(--color-fg-subtle)]"
        strokeWidth={2.2}
      />
    </div>
  );
}
