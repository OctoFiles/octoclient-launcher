# OctoClient Cosmetics API

Damit man die Kosmetics **anderer OctoClient-Nutzer auf jedem Server** sieht
(auch auf pvphub, Hypixel usw.), ohne dass der Server die Mod installiert hat.

```
Spieler A ──POST /v1/loadouts──►  dieser Dienst  ◄──GET /v1/loadouts── Spieler B
```

Jeder Client lädt sein eigenes Loadout unter seiner UUID hoch und fragt alle
5 Sekunden die Loadouts der Spieler in seiner Umgebung ab.

## Starten

```bat
python octoclient_api.py
```

Standard: `0.0.0.0:8765`, Datenbank `loadouts.db` daneben, kein Token.

Sinnvolle Varianten:

```bat
python octoclient_api.py --local                 :: nur 127.0.0.1 (nur eigener PC / LAN-Test)
python octoclient_api.py --port 9000 --token geheim
python octoclient_api.py --prune-days 7          :: alte Einträge nach 7 Tagen löschen
```

Nur Python 3.8+ nötig, keine Abhängigkeiten (`pip install` nicht erforderlich).

## Client konfigurieren

Datei `run/config/octoclient_api.json` (wird beim ersten Start automatisch
angelegt):

```json
{
  "enabled": true,
  "url": "http://127.0.0.1:8765",
  "token": "",
  "pollSeconds": 5
}
```

- `url` → Adresse des Dienstes. Für Freunde im Internet: die öffentliche
  Adresse deines Servers, z. B. `https://cosmetics.deinedomain.de`
  (am besten hinter nginx/Caddy mit HTTPS).
- `token` → muss dem `--token` des Servers entsprechen, sonst leer lassen.
- `enabled` → `false` schaltet die geteilten Kosmetics komplett ab.

Nach Änderungen den Client neu starten (die Datei wird beim ersten Tick
gelesen).

## Endpunkte

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/health` | Status + Anzahl Einträge, Spieler und Nachrichten |
| `POST` | `/v1/loadouts` | Loadout speichern (`{"uuid","name","loadout"}`) |
| `GET` | `/v1/loadouts?uuid=..&uuid=..` | bis zu 100 Loadouts abfragen |
| `DELETE` | `/v1/loadouts/<uuid>` | Eintrag löschen |
| `*` | `/v1/friends/...` | Freundessystem + Chat, siehe unten |

Das `loadout`-Feld beginnt mit dem 9-Feld-String
(`bandana|wings|hat|hatColor|halo|haloColor|aura|auraColor|auraShape`).
Optional folgen Cape, Accessory, Hat-Design, MiniMe-Skin-Benutzername,
Katalogauswahl und Nametag-Einstellungen. Ein späteres Feld benötigt leere Platzhalter für ausgelassene
frühere Felder, z. B.
`Black Lightning Bandana|Black Onyx Wings|0|0|0|0|0|0|Ring|||Fedora`.
Ältere Loadouts bleiben lesbar.

## Freundessystem & Chat

Ein Spieler sucht sich einen Namen, andere können ihn darüber hinzufügen und
ihm danach direkt schreiben. Alles landet in derselben `loadouts.db`
(Tabellen `players`, `friends`, `messages`) und wird von `octoclient_friends.py`
bedient – das Modul liegt neben `octoclient_api.py` bzw. `pa_wsgi.py`.

**Namen:** 2–16 Zeichen, `A-Z a-z 0-9 _`, Groß-/Kleinschreibung egal, eindeutig.
Ein Name gehört zur Minecraft-UUID, nicht zum Skin-/Loadout-Namen.

**Ablauf im Client**

1. Beim Start einmal registrieren (Namen festlegen):

   ```http
   POST /v1/friends/register
   {"uuid": "<eigene UUID>", "name": "Docto"}
   ```

   Antwort: `{"ok":true,"uuid":"…","name":"Docto","secret":"…"}`.
   Das `secret` kommt **nur beim ersten Mal** und gehört in die Client-Config
   (z. B. `config/octoclient_friends.json`). Umbenennen geht jederzeit mit
   demselben `X-Octo-Secret`; ohne Secret antwortet der Server mit `401`.

2. Freunde finden und anfragen:

   ```http
   GET  /v1/friends/lookup?name=Freund      -> {"player":{"uuid":"…","name":"Freund"}}
   POST /v1/friends/request  {"name": "Freund"}     (oder {"uuid": "…"})
   ```

3. Der andere sieht die Anfrage unter `GET /v1/friends` (`incoming`) und nimmt an:

   ```http
   GET  /v1/friends
   POST /v1/friends/accept  {"uuid": "<uuid des Anfragenden>"}
   ```

4. Schreiben und abholen:

   ```http
   POST /v1/friends/messages {"to": "<uuid>", "body": "hi"}
   GET  /v1/friends/inbox?since=<letzte id>                        # neue Nachrichten von allen
   GET  /v1/friends/messages?with=<uuid>&since=<letzte id>         # ein Chatverlauf
   ```

Alle Aufrufe ab Schritt 2 laufen als Spieler und senden zwei Header:

```http
X-Octo-Player: <eigene UUID>
X-Octo-Secret: <secret aus der Registrierung>
```

Zusätzlich gilt weiter das optionale Server-Token als `Authorization: Bearer …`.

**Endpunkte**

| Methode | Pfad | Zweck |
|---|---|---|
| `POST` | `/v1/friends/register` | Namen belegen / umbenennen (`{"uuid","name"}`) |
| `GET` | `/v1/friends/lookup?name=..` | UUID zu einem Namen |
| `GET` | `/v1/friends` | Freunde mit `status`/`detail`/`lastSeen`, offene Anfragen (`incoming`/`outgoing`), ungelesen pro Chat |
| `POST` | `/v1/friends/presence` | Heartbeat (`{"state":"online"}`) bzw. „im Spiel“ (`{"state":"ingame","detail":"Server"}`) |
| `POST` | `/v1/friends/request` | Anfrage senden (`{"name"}` oder `{"uuid"}`) |
| `POST` | `/v1/friends/accept` | Anfrage annehmen (`{"uuid"}`) |
| `POST` | `/v1/friends/remove` | Freund entfernen / Anfrage zurückziehen (`{"uuid"}`) |
| `POST` | `/v1/friends/messages` | Nachricht senden (`{"to","body"}`, max. 500 Zeichen) |
| `GET` | `/v1/friends/messages?with=..&since=..&limit=..` | Chatverlauf, max. 100 pro Abruf |
| `GET` | `/v1/friends/inbox?since=..&limit=..` | neue Nachrichten von allen Freunden |

`status` ist `online`, `ingame` oder `offline`. Wer 120 Sekunden nichts schickt,
wird automatisch `offline`; jeder authentifizierte Aufruf zählt als Lebenszeichen,
ein eigener `presence`-Aufruf setzt zusätzlich `ingame` + Detailtext.

Nachrichten gehen nur zwischen angenommenen Freunden (`403` sonst).
`since` ist immer die zuletzt gesehene Nachrichten-`id`; die Antwort liefert
 sie als `last` zurück. Abgerufene Nachrichten im Chat gelten damit als gelesen.
Alte Nachrichten löscht `--chat-days` (Standard 90 Tage).

**Grenze der Absicherung:** Wer die UUID eines Spielers kennt, kann ihn nicht
übernehmen, solange das Secret geheim bleibt – aber die UUID selbst wird nicht
per Mojang-Session geprüft. Für ein öffentliches Angebot ist das ausreichend
gegen Zufall/Neugier, nicht gegen jemanden, der es gezielt darauf anlegt.

## Chat ohne zweiten Account testen

`testfriend.py` ist ein Testfreund: Er läuft auf deinem PC, verbindet sich mit
derselben API und verhält sich wie ein echter Freund — nimmt Anfragen an,
antwortet auf Nachrichten, meldet sich `online` oder `ingame`.

```bat
python testfriend.py                                  :: wartet auf deine Anfrage
python testfriend.py --friend DeinName                :: fragt dich direkt an
python testfriend.py --state ingame --detail "Frost Survival"
```

Seine UUID + sein Secret landen in `testfriend.json`, der Name bleibt also
erhalten. Das Terminal des Testfreunds ist dein „zweiter Bildschirm“: dort
siehst du jede Nachricht, die du im Launcher schickst, und seine Antwort.
Findet er die API nicht, hilft `--server http://127.0.0.1:8765` für lokale Tests.

## Hosting-Hinweise

- Der Dienst ist absichtlich dumm: er speichert nur UUID → Loadout-String.
- Für öffentliches Hosting `--token` setzen (Clients senden dann
  `Authorization: Bearer <token>`), sonst kann jeder Einträge überschreiben.
- HTTPS-Terminierung macht ein Reverse-Proxy (Caddy: 3 Zeilen, nginx analog).
- Auf PythonAnywhere gehören **beide** Dateien in den Ordner:
  `pa_wsgi.py` und `octoclient_friends.py` (WSGI-Config importiert `pa_wsgi`).
  Gleiches gilt für `octoclient_app.py`, falls du diese Kopie nutzt.

### PythonAnywhere Schritt für Schritt

1. **Files** → `/home/USER/octoclient/` anlegen und `pa_wsgi.py` +
   `octoclient_friends.py` dort hochladen (beide in denselben Ordner).
2. **Web** → *Add a new web app* → **Manual configuration** → Python 3.10+.
3. In der **WSGI configuration file** alles ersetzen durch:

   ```python
   import sys
   sys.path.insert(0, "/home/USER/octoclient")
   from pa_wsgi import application
   ```

4. **Reload** klicken. Die API läuft dann unter
   `https://USER.pythonanywhere.com` (HTTPS inklusive), Test:
   `https://USER.pythonanywhere.com/health`.

   Aktuell deployt: **https://octoclient.pythonanywhere.com**
   (Ordner `/home/OctoClient/octoclient`). Nach dem Upload von
   `octoclient_friends.py` und dem neuen `pa_wsgi.py` muss `/health` zusätzlich
   `"friends": {"players": …, "messages": …}` liefern — daran sieht man, dass
   die neue Version wirklich läuft.
5. `OCTOCLIENT_API_TOKEN` **nicht** setzen: die Anmeldung läuft über die
   `X-Octo-Secret`-Header pro Spieler. Ist das Token gesetzt, weist der Server
   jede Anfrage ohne passenden Bearer-Header ab — der Launcher sendet ihn nicht.

Die Datenbank liegt als `/home/USER/octoclient/loadouts.db` im Home-Verzeichnis
und bleibt bei Reloads erhalten. Kontingent: die freie Stufe reicht für ein
paar Dutzend Spieler locker, weil jede Anfrage nur wenige SQLite-Zeilen liest.
- Rate-Limit ist eingebaut (20 Requests/s pro IP, Burst 60).
- `loadouts.db` sichern, wenn dir die Einträge wichtig sind; ansonsten sind sie
  jederzeit neu hochladbar.
