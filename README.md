# OctoClient

Modularer Minecraft-Launcher als **Rust + Tauri 2**-Desktop-App mit React/TypeScript/three.js.
Kein Shop und keine Dummy-Accounts: Konten starten leer.

---

## Voraussetzungen

| Tool | Version |
| --- | --- |
| Node.js + npm | ≥ 20 (getestet mit 26.13) |
| Rust | stable, MSVC-Toolchain |
| Visual Studio Build Tools | „Desktop development with C++“ (Linker) |
| WebView2 | auf Windows 10/11 vorinstalliert |

Die Tauri-CLI liegt als devDependency im Projekt – eine globale Installation ist nicht nötig.

## Starten

```bash
npm install
```

**Browser-Vorschau** (schnell, ohne Rust – nutzt das Mock-Backend):

```bash
npm run dev        # http://127.0.0.1:1420
```

**Desktop-App** (echtes Rust-Backend, echter Login, echte Window-Controls):

```bash
npm run tauri dev
npm run tauri build   # Installer unter src-tauri/target/release/bundle
```

**Checks:**

```bash
npm run typecheck
npm run build
cd src-tauri && cargo check
```

---

## Projektstruktur

```
src/
  App.tsx                       Seitenwechsel + App-Gerüst
  components/
    galaxy/GalaxyCanvas.tsx     Milchstraße, Sterne, Sternschnuppen, Ringplanet
    navigation/Sidebar.tsx      Navigation (Spielen, Instanzen, News, Skins, Settings)
    ui/                         Button, Field, Select, Slider, Toggle, Modal, SkinHead …
    window/TitleBar.tsx         Frameless-Titelleiste + Window-Controls
  features/
    play/
      PlayView.tsx              Favoriten-Switcher, PLAY-Button, rechte Seitenleiste
      PlayerStage.tsx           three.js-Bühne, Nametag-Projektion, Drag-Rotation
      minecraft/
        skinLayout.ts           kanonisches 64×64-UV-Layout (einzige Quelle)
        skin.ts                 prozedurale Skins (SKINS-Liste)
        cape.ts                 Cape-Texturen (CAPES-Liste)
        player.ts               Rig, Cape-Physik, Idle-Animation
    instances/InstancesView.tsx Instanzen: Version + Mod-Profil, Favoriten, aktiv setzen
    news/NewsView.tsx           Filter, Suche, aufklappbare Changelogs
    skins/SkinsView.tsx         Live-Vorschau + Skin-/Cape-Auswahl
    settings/SettingsView.tsx   5 Tabs (Java/RAM, Spiel, Verhalten, Darstellung, System)
    auth/AuthModal.tsx          Device-Code-Login, Account, Abmelden
  lib/
    bridge.ts                   invoke-Wrapper + Event-Listener
    bridge-types.ts             IPC-Vertrag (Typen, eine Quelle für beide Seiten)
    mock-backend.ts             Browser-Implementierung desselben Vertrags
    defaults.ts                 Default-Config (Spiegel von config.rs)
    instances.ts                Instanz-Helfer (aktivieren, anlegen, Favoriten)
    types.ts                    Domänentypen
  state/LauncherProvider.tsx    zentraler Zustand, Debounced-Autosave, Auth-Events
  data/news.ts                  lokaler News-Feed
  data/versions.ts              bekannte Versionen/Profile
  styles/                       Tokens, UI, App-Layout (app.css lädt vor Feature-CSS)

src-tauri/src/
  lib.rs                       Builder, Command-Registrierung, Setup
  state.rs                     AppState: Config, Pfade, HTTP, Auth
  paths.rs                     %APPDATA%-Pfade (config, data, skins)
  storage.rs                   atomares JSON-Lesen/Schreiben
  config.rs                    Settings-Modell, Defaults, normalized()
  error.rs                     einheitliche Fehler -> { code, message }
  auth/
    mod.rs                     AuthManager, PendingLogin, Refresh
    microsoft.rs               Device-Code-Flow (OAuth2)
    xbox.rs                    Xbox Live -> XSTS -> Minecraft Services
    account.rs                 Account-Modell + Skin-Avatar
    store.rs                   Keyring-Speicherung + Datei-Fallback
  launcher.rs                  Java-Erkennung, Versions-Scan, Startbefehl
  news.rs                      Remote-Feed-Fetch
  commands/
    config.rs  auth.rs  instances.rs  launcher.rs  news.rs  system.rs
```

**Datenfluss:** UI → `lib/bridge.ts` (`invoke`) → `commands/*.rs` → Module.
`bridge-types.ts` ist der Vertrag; `mock-backend.ts` implementiert ihn für den Browser.
Damit lässt sich die Oberfläche ohne Rust entwickeln, ohne UI-Code zu duplizieren.

---

## Funktionsumfang

- **Spielen** – 3D-Charakter (Kopf, Overlay, Arme, Beine, Cape) rahmenlos auf dem Galaxy-
  Hintergrund, Vanilla-Nametag, Drag-Rotation, großer PLAY-Button. Über den Pfeil über dem
  Button wechselst du zwischen favorisierten Instanzen; Version/Mod-Profil stehen nicht mehr hier.
- **Instanzen** – beliebig viele Setups aus Minecraft-Version + Mod-Profil, Favoriten markieren,
  aktive Instanz wählen, umbenennen/löschen. Die aktive Instanz wird gestartet.
- **News & Patches** – Kategorien (Patch/Update/Info), Suche, Datum, Version, aufklappbare Changelogs.
- **Skins & Capes** – 5 Skins, 5 Capes, Live-3D-Vorschau; Auswahl wird gespeichert.
- **Einstellungen** – Java-Pfad + Erkennung, RAM-Slider, JVM-Args, Auflösung, Spielverzeichnis,
  Startverhalten, Discord-RPC-Schalter, Galaxy-Performance, Autosave, Config-Reset.
  Version und Mod-Profil liegen bewusst nicht hier, sondern im Tab **Instanzen**.
- **Microsoft-Login** – Device-Code-Flow, Token-Refresh, Username/UUID/Avatar, Abmelden.
- **Fenster** – frameless, eigene Minimieren/Maximieren/Schließen-Buttons über Tauri-APIs.

---

## Microsoft-Login einrichten

Der Flow ist vollständig implementiert (Device Code → Xbox Live → XSTS → Minecraft Services).
Als Public Client ist `e16699bb-2aa8-46da-b5e3-45cbcce29091` fest eingetragen; die
Device-Code-Anfrage gegen `login.microsoftonline.com/consumers` wurde erfolgreich geprüft.
Der Login funktioniert damit ohne weitere Einrichtung für persönliche Microsoft-Konten.

Für eine **eigene** Azure-/Entra-App:

1. Entra ID → App registration, Kontotyp „Personal Microsoft accounts“.
2. Plattform „Mobile and desktop applications“, **Allow public client flows = Yes** (Device Code).
3. API-Berechtigung **Xbox Live → XboxLive.signin** (delegated) + `offline_access`.
4. Client-ID eintragen: Einstellungen → *System & Integrationen* → Microsoft Client-ID,
   oder Umgebungsvariable `FROST_MS_CLIENT_ID` (überschreibt den Default).

> Hinweis: Die Client-ID ist kein Geheimnis (Public Client), aber die App muss
> „Allow public client flows“ aktiviert haben – sonst lehnt Microsoft den Device Code ab.
> Es wird nie ein Fake-Account erzeugt; Fehler werden im Login-Dialog angezeigt.

Tokens liegen im Windows Credential Manager (`frost-client-launcher` / `microsoft-account`).
Ist kein Keyring verfügbar, greift `auth-session.json` im App-Data-Verzeichnis (Warnung im Log).

**Angemeldet bleiben:** Der Access-Token wird beim Start und danach alle 10 Minuten
geprüft. Läuft er in weniger als 2 Stunden ab, erneuert ihn ein Hintergrund-Task still
über den Refresh-Token (Microsoft rotiert ihn dabei, der neue wird sofort gespeichert).
Die Sitzung bleibt also bestehen, bis du dich abmeldest oder Microsoft den Refresh-Token
ablehnt (z. B. nach einem Passwortwechsel). Die frühere Zeile „Token gültig bis“ war nur
die Access-Token-Laufzeit und heißt jetzt „Sitzung: Bleibt aktiv“.

## Persistenz

| Datei | Inhalt |
| --- | --- |
| `config.json` | Einstellungen, Skin, Cape, Instanzen (Version + Mod-Profil) und aktive Instanz |
| Keyring / `auth-session.json` | Microsoft-Session + Refresh-Token |

Ablage über Tauri `app_config_dir` / `app_data_dir` (Windows: `%APPDATA%\gg.frostclient.launcher`).
Alle Dateien werden versioniert und tolerant gelesen; defekte Werte fallen auf Defaults zurück.

---

## Platzhalter & Erweiterungspunkte

Diese Stellen sind bewusst als Schnittstelle vorbereitet und funktionieren ohne Server lokal weiter:

### 1. Remote-News (`news.rs`)
`integrations.newsFeedUrl` setzen (HTTPS, lokal auch `http://localhost`).
Antwort: `NewsItem[]` oder `{ "items": [...] }` mit
`id, title, category ("patch"|"update"|"info"), version, date, summary, body[], tags[], url`.
Ohne URL bleibt der lokale Feed aus `src/data/news.ts` aktiv.

### 2. Discord Rich Presence
`discord.appId` in den Einstellungen setzen (Developer Portal → Applications).
`discord.rs` verbindet sich per IPC (`discord-ipc-0..9`) und aktualisiert die
Presence alle 20 s mit Instanz und Minecraft-Version. Ohne App-ID bleibt sie aus.

### 3. Spiel-Download/Installer (`launcher.rs`)
`build_plan` startet **installierte** Versionen (`versions/<id>/<id>.json`) mit dem echten
Minecraft-Token. Fehlt die Version, kommt ein klarer Fehler. Der dokumentierte Erweiterungspunkt
ist ein Downloader für Manifest, Libraries, Assets und Natives direkt vor `build_plan`.

### 4. Cape-/Skin-Server
Skins und Capes werden lokal prozedural erzeugt (`skin.ts`, `cape.ts`).
Ein Cape-Server/Cape-Upload lässt sich in `SkinsView` + einem neuen Command anbinden;
die Texturen sind bereits als Canvas/Data-URL kapseln.

### 6. Browser-Vorschau
`mock-backend.ts` beantwortet alle Commands lokal (localStorage). Der Login endet dort bewusst
mit dem Hinweis „nur in der Desktop-App“ – kein Fake-Account. Window-Controls sind im Browser
ohne Funktion (in Tauri echt).

### 7. Build/Signierung
Icons werden per `npm run icons` erzeugt. Code-Signing, Auto-Update und Installer-Branding
sind nicht konfiguriert.

---

## Erweitern

- **Neuer Skin/Cape:** Eintrag in `SKINS`/`CAPES` ergänzen – UVs kommen ausschließlich aus
  `skinLayout.ts`, Malerei und 3D-Modell bleiben synchron.
- **Neue Seite:** Komponente unter `src/features/<name>/`, Eintrag in `Sidebar.tsx` und im
  Seiten-Router in `App.tsx`.
- **Neuer Command:** Funktion in `commands/*.rs`, Registrierung in `lib.rs`, Typ in
  `bridge-types.ts`, Wrapper in `bridge.ts`, Mock in `mock-backend.ts`.
- **Neue Einstellung:** Feld in `config.rs` (+ `normalized()` und Default), Spiegel in
  `lib/defaults.ts`, UI in `SettingsView.tsx`.
