import type { ReactNode } from "react";

// Small, dependency-free UI primitives (server-component friendly).

export function Card({ title, children, actions, className = "" }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-gray-200 bg-white p-5 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-gray-900">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const BADGE: Record<string, string> = {
  green: "bg-green-50 text-green-800 ring-green-600/20",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/30",
  red: "bg-red-50 text-red-800 ring-red-600/20",
  blue: "bg-blue-50 text-blue-800 ring-blue-600/20",
  gray: "bg-gray-100 text-gray-700 ring-gray-500/20",
};

export function Badge({ tone = "gray", children, title }: { tone?: keyof typeof BADGE; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  type = "submit",
  name,
  value,
  disabled,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  type?: "submit" | "button";
  name?: string;
  value?: string;
  disabled?: boolean;
}) {
  const styles = {
    primary: "bg-brand-600 text-white hover:bg-brand-700",
    secondary: "bg-white text-gray-800 ring-1 ring-gray-300 hover:bg-gray-50",
    danger: "bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50",
  }[variant];
  return (
    <button type={type} name={name} value={value} disabled={disabled} className={`inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${styles}`}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  const styles = variant === "primary" ? "bg-brand-600 text-white hover:bg-brand-700" : "bg-white text-gray-800 ring-1 ring-gray-300 hover:bg-gray-50";
  return (
    <a href={href} className={`inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium ${styles}`}>
      {children}
    </a>
  );
}

export function Field({ label, name, type = "text", required, placeholder, defaultValue, hint, autoComplete }: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-gray-800">
        {label} {!required && <span className="font-normal text-gray-500">(optional)</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500"
      />
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = "blue", children }: { tone?: "blue" | "amber" | "red" | "green"; children: ReactNode }) {
  const s = {
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    amber: "border-amber-300 bg-amber-50 text-amber-950",
    red: "border-red-200 bg-red-50 text-red-900",
    green: "border-green-200 bg-green-50 text-green-900",
  }[tone];
  return <div role={tone === "red" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${s}`}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center">
      <h3 className="text-base font-semibold text-gray-900">{title}</h3>
      <div className="mx-auto mt-2 max-w-xl text-sm text-gray-600">{children}</div>
    </div>
  );
}

export function SimulatedBanner({ what }: { what: string }) {
  return (
    <Notice tone="amber">
      <strong>SIMULATED — sample data.</strong> {what} These numbers are generated for demonstration and are <strong>not your real business results</strong>.
    </Notice>
  );
}
