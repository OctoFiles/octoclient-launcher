import { Maximize2, Minus, PanelsTopLeft, UserRound, X } from "lucide-react";
import { useState } from "react";

import { closeWindow, minimizeWindow, toggleMaximize } from "../../lib/window";
import { useLauncher } from "../../state/LauncherProvider";
import { OctoMark } from "../brand/OctoMark";
import { SkinHead } from "../ui/SkinHead";
import "./titlebar.css";

interface TitleBarProps {
  onOpenAuth: () => void;
}

export function TitleBar({ onOpenAuth }: TitleBarProps) {
  const { account, config, system } = useLauncher();
  const [maximized, setMaximized] = useState(false);

  const onToggleMaximize = async () => {
    setMaximized(await toggleMaximize());
  };

  return (
    <header className="titlebar">
      <div
        className="titlebar__drag"
        data-tauri-drag-region
        onDoubleClick={() => void onToggleMaximize()}
      />
      <div className="titlebar__content">
        <div className="brand">
          <span className="brand__mark">
            <OctoMark size={17} />
          </span>
          <span className="brand__text">
            OCTO<span>CLIENT</span>
          </span>
          <span className="brand__version">v{system?.appVersion ?? "0.1.0"}</span>
        </div>

        <div className="titlebar__spacer" />

        <button type="button" className="account-chip" onClick={onOpenAuth}>
          {account ? (
            <SkinHead
              skinId={config.profile.skinId}
              skinDataUrlSrc={config.profile.customSkinDataUrl ?? account.skinDataUrl}
              size={26}
            />
          ) : (
            <span className="account-chip__placeholder">
              <UserRound size={15} />
            </span>
          )}
          <span className="account-chip__text">
            <span className="account-chip__name">
              {account?.username ?? "Anmelden"}
            </span>
            <span className="account-chip__hint">
              {account ? "Microsoft-Konto" : "Mit Microsoft"}
            </span>
          </span>
        </button>

        <div className="window-controls">
          <button type="button" onClick={() => void minimizeWindow()} aria-label="Minimieren">
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={() => void onToggleMaximize()}
            aria-label={maximized ? "Wiederherstellen" : "Maximieren"}
          >
            {maximized ? <PanelsTopLeft size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="window-controls__close"
            onClick={() => void closeWindow()}
            aria-label="Schließen"
          >
            <X size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
