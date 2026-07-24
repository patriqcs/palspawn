# PalSpawn

Web-Admin-Tool für Palworld-Server mit Tab-Oberfläche:

- **Items** — alle 2453 Palworld-Items (mit Bild, deutschem + englischem Namen,
  Rarität), durchsuch-, filter- und sortierbar; spawnt ausgewählte Items in
  gewünschter Menge ins Inventar eines Online-Spielers.
- **Spieler** — Online-Liste (Level, Position, IDs mit Klick-zum-Kopieren),
  Kick/Ban/Unban, Teleport (Koordinaten, gespeicherte Orte, zu Spieler),
  Charakter-Aktionen: HP setzen, Party-Pals umbenennen, Items entfernen,
  Zufalls-Drop.
- **Pals** — Wild-Pals spawnen (ID, Anzahl, Level, Despawn-Timer), gefangene
  Pals des Spielers spawnen, Weltzeit setzen (Tag/Nacht), WildWrath.
- **Server** — Dashboard (FPS, Frametime, Spieler, Uptime, Ingame-Tage, Basen),
  Ankündigungen, Welt speichern, Shutdown mit Countdown, Force-Stop, alle
  Server-Settings durchsuchbar (read-only).
- **Logs** — Mod-Status der Paladdon-Bridge (Version, armed, Fehler),
  Twitch-Troll-Pause, Bridge-Log; im PalDefender-Modus eine RCON-Konsole.

Welche Tabs/Panels sichtbar sind, richtet sich nach den konfigurierten
Backends (Feature-Flags aus `/api/config`). Gefährliche Aktionen (Kick, Ban,
Shutdown, Force-Stop, Item entfernen, WildWrath) fragen immer nach Bestätigung.

Items inkl. Icons sind ins Image gebundelt (keine Internetverbindung zur Laufzeit nötig).

## Backends (kombinierbar)

Die **In-Game-Funktionen** (Items, Teleport, Pals, Charakter-Aktionen) laufen
über das gewählte Backend (`paladdon` oder `paldefender`). Die
**Server-Administration** (Server-Tab, Kick/Ban/Unban) nutzt die offizielle
Palworld REST API und ist unabhängig davon aktiv, sobald
`PALWORLD_API_URL` + `PALWORLD_API_PASS` gesetzt sind — auch im
paladdon-Modus (auf dem palchaos-Server läuft die REST API containerintern
auf Port 8212, `REST_API_ENABLED=true` im Compose).

### 1. `paladdon` (Standard, sobald `BRIDGE_URL` gesetzt ist)

Für den palchaos-Server (GE-Proton + UE4SS + PalChaos-Mod, **kein RCON**):
Spielerliste aus `GET /api/status` der [Paladdon-Bridge](../paladdon), Item-Spawn als
`giveItem`-Steps über `POST /api/command` (Bearer `ADMIN_TOKEN` der Bridge).
Volles Inventar meldet der Mod als Fehler pro Item zurück.

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `BRIDGE_URL` | ja | z. B. `http://<unraid-ip>:8420` |
| `BRIDGE_TOKEN` | ja | `ADMIN_TOKEN` der Paladdon-Bridge |
| `PALWORLD_API_URL` + `PALWORLD_API_PASS` | optional | schaltet zusätzlich den Server-Tab + Kick/Ban frei (offizielle REST API) |

Genutzte Bridge-Ops: `giveItem`, `getPos`, `teleportTo`/`teleportOffset`/`teleportToPlayer`,
`announce`, `setGameHour`, `setHpRate`, `wildWrath`, `renamePartyPals`, `removeItem`,
`dropRandomSlot`, `spawnPal`, `spawnCaughtPal` — plus Bridge-Status/-Logs/-Pause.

> **Server-Tab auf dem palchaos-Server:** Der REST-API-Port 8212 ist dort bewusst
> nicht published (Reverse-Proxy würde ihn exponieren). Stattdessen den
> palspawn-Container ins Docker-Netz des Palworld-Containers hängen
> (`docker network connect <netz> palspawn`) und
> `PALWORLD_API_URL=http://<palworld-containername>:8212` setzen.
> Ohne `PALWORLD_API_URL` bleibt der Server-Tab ausgeblendet.

### 2. `paldefender` (Fallback für Server mit RCON)

Für Server mit [PalDefender](https://www.nexusmods.com/palworld/mods/451):
Spielerliste über die offizielle REST API (`/v1/api/players`), Item-Spawn per RCON
(`give <UserId> <ItemId> <Amount>`). Voraussetzungen: PalDefender installiert,
`RESTAPIEnabled=True` (Port 8212) und `RCONEnabled=True` (Port 25575) in der
`PalWorldSettings.ini`. Umgebungsvariablen siehe Tabelle unten.

`BACKEND=paladdon|paldefender` erzwingt einen Modus explizit.

## Deployment in Unraid

Image wird von GitHub Actions automatisch nach GHCR gebaut:
`ghcr.io/patriqcs/palspawn:latest`

In Unraid: **Docker → Add Container** — oder per Compose: [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
(Secrets in `deploy/.env`, Vorlage: `deploy/.env.example`)

| Feld | Wert |
|---|---|
| Repository | `ghcr.io/patriqcs/palspawn:latest` |
| Port | `8080` → beliebiger Host-Port |

### Umgebungsvariablen

| Variable | Pflicht | Default | Beschreibung |
|---|---|---|---|
| `BRIDGE_URL` | Backend paladdon | – | Paladdon-Bridge, z. B. `http://192.168.1.50:8420` |
| `BRIDGE_TOKEN` | Backend paladdon | – | `ADMIN_TOKEN` der Bridge |
| `BACKEND` | nein | auto | `paladdon` wenn `BRIDGE_URL` gesetzt, sonst `paldefender` |
| `PALWORLD_API_URL` | Backend paldefender; sonst optional | – | offizielle REST API, z. B. `http://192.168.1.50:8212` — schaltet Server-Tab + Kick/Ban frei |
| `PALWORLD_API_PASS` | mit `PALWORLD_API_URL` | – | AdminPassword des Servers |
| `PALWORLD_API_USER` | nein | `admin` | Basic-Auth-User der REST API |
| `RCON_HOST` | nein | Host aus `PALWORLD_API_URL` | IP des Palworld-Servers |
| `RCON_PORT` | nein | `25575` | RCON-Port |
| `RCON_PASSWORD` | nein | `PALWORLD_API_PASS` | RCON-Passwort |
| `GIVE_COMMAND_TEMPLATE` | nein | `give {userId} {itemId} {amount}` | Befehls-Template, falls abweichend |
| `BANLIST_FILE` | nein | – | Pfad zur `banlist.txt` des Servers (read-only mounten, z. B. SaveGames-Ordner → `/palsaves`); schaltet die Bann-Auswahl beim Entbannen frei |
| `DATA_DIR` | nein | `./data` | Persistente Daten (gemerkte Spielernamen zu Banns) — als Volume mounten, z. B. `/data` |
| `SETTINGS_INI` | nein | – | Pfad zur `PalWorldSettings.ini` (rw mounten); schaltet den Settings-Editor im Server-Tab frei. Änderungen greifen erst nach Server-Neustart. `AdminPassword`/`ServerPassword`/`RESTAPIEnabled`/`RESTAPIPort` sind nie editierbar |
| `SETTINGS_LOCKED_KEYS` | nein | ServerName, ServerPlayerMaxNum, RCONEnabled, CrossplayPlatforms, PublicPort | Keys, die der Server-Container beim Start aus ENV überschreibt — in der UI gesperrt (🔒) |
| `APP_USER` / `APP_PASS` | nein | – | Wenn gesetzt: Basic-Auth-Login vor der Web-UI |
| `PORT` | nein | `8080` | HTTP-Port der Web-UI |

> **Hinweis:** Die Web-UI hat ohne `APP_USER`/`APP_PASS` keinen Login — nur im LAN
> betreiben und nicht ins Internet freigeben.

### Beispiel (docker run)

```bash
# palchaos-Server (Paladdon-Bridge):
docker run -d --name palspawn \
  -p 8080:8080 \
  -e BRIDGE_URL=http://192.168.1.50:8420 \
  -e BRIDGE_TOKEN=meinAdminToken \
  ghcr.io/patriqcs/palspawn:latest

# Alternativ (PalDefender-Server):
docker run -d --name palspawn \
  -p 8080:8080 \
  -e PALWORLD_API_URL=http://192.168.1.50:8212 \
  -e PALWORLD_API_PASS=meinAdminPasswort \
  ghcr.io/patriqcs/palspawn:latest
```

## Lokale Entwicklung

```bash
npm install
PALWORLD_API_URL=http://<server>:8212 PALWORLD_API_PASS=... node server.js
# → http://localhost:8080
```

## GitHub einrichten

1. Repository auf GitHub anlegen und pushen — der Workflow
   `.github/workflows/docker.yml` baut bei jedem Push auf `main` das Image
   und veröffentlicht es unter `ghcr.io/patriqcs/palspawn`.
2. Beim ersten Mal ggf. unter *Package settings* das Paket auf **public** stellen,
   damit Unraid ohne Login pullen kann.

## Datenquellen

- Item-Daten & Icons: [paldb.cc](https://paldb.cc) (Stand Juli 2026, Spielversion laut `DT_ItemDataTable`)
- REST-API-Doku: [docs.palworldgame.com](https://docs.palworldgame.com/category/rest-api/)
- PalDefender-Befehle: [PalDefender Wiki](https://ultimeit.github.io/PalDefender/Commands/)

### Item-Daten aktualisieren

`public/items.json` und `public/icons/` sind statisch gebundelt. Nach einem großen
Palworld-Update die Tabellen `https://paldb.cc/en/Items_Table` und `/de/Items_Table`
neu parsen (Icon-URLs: `cdn.paldb.cc/image/Others/InventoryItemIcon/Texture/*.webp`).
