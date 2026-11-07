/**
 * UI 基元 —— 按 dsh `dsh-client-ui-primitives` 的「语义令牌 + 小组件组合」方式重写，
 * 不复用旧前端 shadcn/ui 组件，也不引入任何 UI 库。
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "default",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
}) {
  return <button className="btn" data-variant={variant} type="button" {...rest} />;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "success";
}) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>;
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {subtitle !== undefined && <p>{subtitle}</p>}
    </header>
  );
}

export function Spinner({ label = "加载中" }: { label?: string }) {
  return (
    <div className="center" role="status" aria-label={label}>
      <div className="spinner" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M3 5h18v14H3V5zm0 9h5l1 2h6l1-2h5" strokeLinejoin="round" />
      </svg>
      <strong>{title}</strong>
      {description !== undefined && <span>{description}</span>}
    </div>
  );
}

export function Toast({
  message,
  variant = "success",
}: {
  message: string;
  variant?: "success" | "danger";
}) {
  return (
    <div className="toast" data-variant={variant} role="status">
      {message}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}

export function NavGlyph({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d={path} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
