import type { ReactNode } from "react";

interface SettingRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  stacked?: boolean;
}

export function SettingRow({ label, description, children, stacked }: SettingRowProps) {
  return (
    <div className={["setting-row", stacked ? "setting-row--stacked" : ""].filter(Boolean).join(" ")}>
      <div className="setting-row__text">
        <span className="setting-row__label">{label}</span>
        {description ? <span className="setting-row__hint">{description}</span> : null}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}
