import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

import type { Toast } from "../../state/LauncherProvider";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};

interface ToastsProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`}>
            <Icon size={16} className="toast__icon" />
            <span className="toast__text">{toast.message}</span>
            <button
              type="button"
              className="toast__close"
              onClick={() => onDismiss(toast.id)}
              aria-label="Hinweis schließen"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
