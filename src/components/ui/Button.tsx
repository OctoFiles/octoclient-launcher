import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Spinner } from "./Spinner";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "btn",
        `btn--${variant}`,
        `btn--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === "lg" ? 18 : 14} /> : icon}
      {children ? <span className="btn__label">{children}</span> : null}
    </button>
  );
}
