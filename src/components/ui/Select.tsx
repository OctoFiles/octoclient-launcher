import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type SelectHTMLAttributes } from "react";

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value" | "defaultValue" | "multiple"> {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  /** Same signature as a native select change event, so call sites stay unchanged. */
  onChange?: (event: { target: { value: string } }) => void;
}

/**
 * Custom dropdown that replaces the native `<select>` popup: a glass panel,
 * full accent highlight and a check mark on the active entry.
 */
export function Select({
  options,
  className,
  value,
  defaultValue,
  onChange,
  disabled,
  ...rest
}: SelectProps) {
  const [internal, setInternal] = useState(defaultValue ?? options[0]?.value ?? "");
  const current = value ?? internal;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement>(null);
  const listId = useId();

  const selected = options.find((option) => option.value === current);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = (next: string) => {
    if (value === undefined) setInternal(next);
    setOpen(false);
    onChange?.({ target: { value: next } });
  };

  const openMenu = () => {
    if (disabled) return;
    const index = Math.max(0, options.findIndex((option) => option.value === current));
    setActiveIndex(index);
    setOpen(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => {
        const next = (index + step + options.length) % options.length;
        return options[next]?.disabled ? index : next;
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) {
        const option = options[activeIndex];
        if (option && !option.disabled) commit(option.value);
      } else {
        openMenu();
      }
    }
  };

  return (
    <span
      ref={rootRef}
      className={["select", open ? "select--open" : "", disabled ? "select--disabled" : "", className]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="select__button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={rest["aria-label"]}
        disabled={disabled}
      >
        <span className="select__value">{selected?.label ?? "–"}</span>
        <ChevronDown className="select__chevron" size={14} aria-hidden="true" />
      </button>

      {open ? (
        <div className="select__menu" role="listbox" id={listId} aria-label={rest["aria-label"]}>
          {options.map((option, index) => {
            const active = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={option.disabled}
                className={[
                  "select__option",
                  active ? "select__option--active" : "",
                  index === activeIndex ? "select__option--focus" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option.value)}
              >
                <span>{option.label}</span>
                {active ? <Check size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </span>
  );
}
