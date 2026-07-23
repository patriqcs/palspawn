# PalSpawn

Web-UI für Palworld-Server mit [PalDefender](https://www.nexusmods.com/palworld/mods/451):
zeigt alle Palworld-Items (mit Bild, deutschem + englischem Namen), durchsuch-, filter- und
sortierbar — und spawnt ausgewählte Items in gewünschter Menge direkt ins Inventar eines
Spielers, der gerade auf dem Server online ist.

- **Spielerliste** kommt von der offiziellen Palworld **REST API** (`/v1/api/players`)
- **Item-Spawn** läuft über **RCON** mit dem PalDefender-Befehl `give <UserId> <ItemId> <Amount>`
- 2453 Items inkl. Icons sind ins Image gebundelt (keine Internetverbindung zur Laufzeit nötig)

## Voraussetzungen auf dem Palworld-Server

1. **PalDefender** ist installiert (der Vanilla-Server hat keinen Give-Befehl).
2. **REST API aktiviert** — in `PalWorldSettings.ini`:
   `RESTAPIEnabled=True`, `RESTAPIPort=8212`, `AdminPassword="..."`.
3. **RCON aktiviert** — `RCONEnabled=True`, `RCONPort=25575` (Passwort = AdminPassword).

## Deployment in Unraid

Image wird von GitHub Actions automatisch nach GHCR gebaut:
`ghcr.io/<github-user>/palspawn:latest`

In Unraid: **Docker → Add Container**

| Feld | Wert |
|---|---|
| Repository | `ghcr.io/<github-user>/palspawn:latest` |
| Port | `8080` → beliebiger Host-Port |

### Umgebungsvariablen

| Variable | Pflicht | Default | Beschreibung |
|---|---|---|---|
| `PALWORLD_API_URL` | ja | – | z. B. `http://192.168.1.50:8212` |
| `PALWORLD_API_PASS` | ja | – | AdminPassword des Servers |
| `PALWORLD_API_USER` | nein | `admin` | Basic-Auth-User der REST API |
| `RCON_HOST` | nein | Host aus `PALWORLD_API_URL` | IP des Palworld-Servers |
| `RCON_PORT` | nein | `25575` | RCON-Port |
| `RCON_PASSWORD` | nein | `PALWORLD_API_PASS` | RCON-Passwort |
| `GIVE_COMMAND_TEMPLATE` | nein | `give {userId} {itemId} {amount}` | Befehls-Template, falls abweichend |
| `APP_USER` / `APP_PASS` | nein | – | Wenn gesetzt: Basic-Auth-Login vor der Web-UI |
| `PORT` | nein | `8080` | HTTP-Port der Web-UI |

> **Hinweis:** Die Web-UI hat ohne `APP_USER`/`APP_PASS` keinen Login — nur im LAN
> betreiben und nicht ins Internet freigeben.

### Beispiel (docker run)

```bash
docker run -d --name palspawn \
  -p 8080:8080 \
  -e PALWORLD_API_URL=http://192.168.1.50:8212 \
  -e PALWORLD_API_PASS=meinAdminPasswort \
  ghcr.io/<github-user>/palspawn:latest
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
   und veröffentlicht es unter `ghcr.io/<user>/palspawn`.
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
