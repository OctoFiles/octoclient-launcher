import { useState } from "react";

// Global layout styles must load before feature-level CSS.
import "./styles/app.css";

import { OctoMark } from "./components/brand/OctoMark";
import { GalaxyBackground } from "./components/galaxy/GalaxyBackground";
import { Sidebar } from "./components/navigation/Sidebar";
import { Toasts } from "./components/ui/Toasts";
import { TitleBar } from "./components/window/TitleBar";
import { AuthModal } from "./features/auth/AuthModal";
import { FriendsView } from "./features/friends/FriendsView";
import { InstancesView } from "./features/instances/InstancesView";
import { NewsView } from "./features/news/NewsView";
import { PlayView } from "./features/play/PlayView";
import { SettingsView } from "./features/settings/SettingsView";
import { SkinsView } from "./features/skins/SkinsView";
import type { PageId } from "./lib/types";
import { LauncherProvider, useLauncher } from "./state/LauncherProvider";
import "./styles/tiles.css";

function BootScreen() {
  return (
    <div className="boot-screen">
      <OctoMark size={46} />
      <span className="boot-screen__mark">OCTOCLIENT</span>
      <span className="boot-screen__sub">Launcher wird geladen…</span>
      <span className="boot-screen__bar" />
    </div>
  );
}

function Shell() {
  const { ready, config, toasts, dismissToast } = useLauncher();
  const [page, setPage] = useState<PageId>("play");
  const [authOpen, setAuthOpen] = useState(false);

  const backgroundMode = config.appearance.backgroundMode;

  return (
    <div className={`app-shell app-shell--bg-${backgroundMode}`}>
      {backgroundMode === "stars" ? (
        <GalaxyBackground
          performance={config.appearance.performance}
          reduceMotion={config.appearance.reduceMotion}
          showParticles={config.appearance.showParticles}
        />
      ) : null}

      {/* Plain <img> so animated GIF backgrounds keep playing; a CSS
          background-image is often frozen to its first frame. */}
      {backgroundMode === "image" && config.appearance.backgroundImage ? (
        <img
          className="app-shell__bg"
          src={config.appearance.backgroundImage}
          alt=""
          aria-hidden="true"
        />
      ) : null}

      <div className="app-surface">
        <TitleBar onOpenAuth={() => setAuthOpen(true)} />

        <div className="app-body">
          <Sidebar page={page} onNavigate={setPage} />
          <main className="app-main">
            {!ready ? (
              <BootScreen />
            ) : (
              <>
                {page === "play" ? (
                  <PlayView
                    onNavigate={setPage}
                    onRequireAuth={() => setAuthOpen(true)}
                  />
                ) : null}
                {page === "friends" ? <FriendsView /> : null}
                {page === "instances" ? <InstancesView /> : null}
                {page === "news" ? <NewsView /> : null}
                {page === "skins" ? <SkinsView /> : null}
                {page === "settings" ? <SettingsView /> : null}
              </>
            )}
          </main>
        </div>
      </div>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

export default function App() {
  return (
    <LauncherProvider>
      <Shell />
    </LauncherProvider>
  );
}
