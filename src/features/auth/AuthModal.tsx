import { Check, Copy, ExternalLink, LogOut, ShieldCheck, Trash2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { SkinHead } from "../../components/ui/SkinHead";
import { Spinner } from "../../components/ui/Spinner";
import { openExternal } from "../../lib/bridge";
import { formatDate } from "../../lib/format";
import { useLauncher } from "../../state/LauncherProvider";
import "./auth.css";

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
}

export function AuthModal({ open, onClose }: AuthModalProps) {
  const {
    account,
    pending,
    accounts,
    config,
    signIn,
    cancelSignIn,
    signOut,
    switchAccount,
    removeAccount,
    openAuthPopup,
    pushToast,
  } = useLauncher();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);
  const wasSignedIn = useRef(Boolean(account));

  // Close the modal right after a successful sign-in.
  useEffect(() => {
    if (open && account && !wasSignedIn.current) onClose();
    wasSignedIn.current = Boolean(account);
  }, [account, open, onClose]);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setCopied(false);
      setAdding(false);
    }
  }, [open]);

  // A second account finished its device-code flow: close the modal.
  useEffect(() => {
    if (adding && pending?.status === "complete") {
      setAdding(false);
      onClose();
    }
  }, [adding, pending, onClose]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const start = async () => {
    setBusy(true);
    await signIn();
    setBusy(false);
  };

  const copyCode = async () => {
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.userCode);
      setCopied(true);
    } catch {
      pushToast("error", "Der Code konnte nicht kopiert werden.");
    }
  };

  const isPending = pending?.status === "pending";
  const failed = pending?.status === "error" || pending?.status === "expired";

  const title = account && !adding
    ? "Dein Konto"
    : isPending
      ? "Bei Microsoft anmelden"
      : "Microsoft-Konto";
  const subtitle = account && !adding
    ? "Sitzung, UUID und Sicherheit"
    : "Xbox Live → Minecraft Services";

  const footer = account && !adding ? (
    <>
      <Button variant="ghost" icon={<LogOut size={14} />} onClick={() => void signOut()}>
        Abmelden
      </Button>
      <Button
        variant="primary"
        loading={busy}
        onClick={() => {
          setAdding(true);
          void start();
        }}
      >
        Konto hinzufügen
      </Button>
    </>
  ) : isPending ? (
    <Button
      variant="ghost"
      onClick={() => {
        setAdding(false);
        void cancelSignIn();
      }}
    >
      Abbrechen
    </Button>
  ) : failed ? (
    <>
      <Button variant="ghost" onClick={() => void cancelSignIn()}>
        Schließen
      </Button>
      <Button variant="primary" loading={busy} onClick={() => void start()}>
        Erneut versuchen
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        Später
      </Button>
      <Button variant="primary" loading={busy} onClick={() => void start()}>
        Mit Microsoft anmelden
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} footer={footer}>
      {account && !adding ? (
        <div className="auth-account">
          <div className="auth-account__head">
            <SkinHead
              skinId={config.profile.skinId}
              skinDataUrlSrc={config.profile.customSkinDataUrl ?? account.skinDataUrl}
              size={56}
            />
            <div className="auth-account__id">
              <h3>{account.username}</h3>
              <p>{account.uuid}</p>
            </div>
            <span className="badge badge--online">Verbunden</span>
          </div>

          <dl className="auth-meta">
            <div>
              <dt>Angemeldet seit</dt>
              <dd>{formatDate(account.signedInAt)}</dd>
            </div>
            <div>
              <dt>Sitzung</dt>
              <dd>Bleibt aktiv</dd>
            </div>
            <div>
              <dt>OAuth-Client</dt>
              <dd>
                {config.integrations.msClientId ? "Eigene Azure-App" : "Standard-Client"}
              </dd>
            </div>
          </dl>

          {accounts.length > 0 ? (
            <div className="auth-accounts">
              <span className="auth-accounts__label">
                <Users size={12} /> Gespeicherte Konten
              </span>
              {accounts.map((entry) => {
                const active = entry.uuid === account.uuid;
                return (
                  <div
                    key={entry.uuid}
                    className={[
                      "auth-account-row",
                      active ? "auth-account-row--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      className="auth-account-row__pick"
                      onClick={() => void switchAccount(entry.uuid)}
                      disabled={active}
                    >
                      <SkinHead skinId={config.profile.skinId} skinDataUrlSrc={entry.skinDataUrl} size={28} />
                      <span className="auth-account-row__name">{entry.username}</span>
                      {active ? <span className="badge badge--online">Aktiv</span> : null}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${entry.username} entfernen`}
                      onClick={() => void removeAccount(entry.uuid)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
              <p className="auth-accounts__hint">
                Wechseln gilt sofort – ohne neue Anmeldung. „Konto hinzufügen“ startet
                einen weiteren Microsoft-Login.
              </p>
            </div>
          ) : null}

          <p className="auth-note">
            <ShieldCheck size={13} />
            Die Sitzung erneuert sich automatisch im Hintergrund. Abmelden löscht den
            Refresh-Token im Schlüsselspeicher des Systems.
          </p>
        </div>
      ) : isPending && pending ? (
        <div className="auth-pending">
          <div className="auth-step">
            <span className="auth-step__num">1</span>
            <div>
              <p>Öffne die Microsoft-Anmeldeseite</p>
              <Button
                variant="secondary"
                size="sm"
                icon={<ExternalLink size={13} />}
                onClick={() => void openAuthPopup(pending.verificationUri)}
              >
                {pending.verificationUri.replace(/^https?:\/\//, "")}
              </Button>{" "}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openExternal(pending.verificationUri)}
              >
                Im Browser öffnen
              </Button>
            </div>
          </div>

          <div className="auth-step">
            <span className="auth-step__num">2</span>
            <div className="auth-step__code">
              <p>Gib diesen Code ein</p>
              <div className="device-code">
                <code>{pending.userCode}</code>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => void copyCode()}
                  aria-label="Code kopieren"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
            </div>
          </div>

          <div className="auth-wait">
            <Spinner size={14} />
            <span>Warte auf die Bestätigung bei Microsoft…</span>
          </div>
          <p className="auth-note">{pending.message}</p>
        </div>
      ) : failed ? (
        <div className="auth-failed">
          <h3>
            {pending?.status === "expired"
              ? "Der Code ist abgelaufen"
              : "Anmeldung fehlgeschlagen"}
          </h3>
          <p>{pending?.error ?? "Bitte fordere einen neuen Code an."}</p>
          <p className="auth-note">
            Tipp: Prüfe, ob das Microsoft-Konto Minecraft (Java Edition) besitzt und
            Xbox Live freigeschaltet ist.
          </p>
        </div>
      ) : (
        <div className="auth-intro">
          <p className="auth-lead">
            OctoClient meldet dich direkt bei Microsoft an — ohne Passwort im
            Launcher und ohne Drittanbieter.
          </p>
          <ul className="auth-steps">
            <li>
              <span>1</span> Code anfordern und auf der Microsoft-Seite bestätigen.
            </li>
            <li>
              <span>2</span> Xbox Live → XSTS → Minecraft Services laufen automatisch.
            </li>
            <li>
              <span>3</span> Profilname, UUID und Skin werden geladen; die Sitzung
              erneuert sich selbst.
            </li>
          </ul>
          <p className="auth-note">
            <ShieldCheck size={13} />
            Deine Zugangsdaten bleiben bei Microsoft. Der Refresh-Token wird verschlüsselt
            im System-Schlüsselspeicher abgelegt.
          </p>
        </div>
      )}
    </Modal>
  );
}
