interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={["toggle", checked ? "toggle--on" : ""].filter(Boolean).join(" ")}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle__thumb" />
    </button>
  );
}
