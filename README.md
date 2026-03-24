# MeshCentral Software Orchestrator v0.2

Diese Version ist die angefragte **zweite Ausbaustufe**:

- modernisierte GUI
- Bulk-Zuweisung many-to-many (mehrere Geräte ↔ mehrere Jobs)
- persistente Queue für Offline-Geräte
- `onConnect`-Ausführung
- Zeitpläne (einmalig, Intervall, täglich, wöchentlich)
- ScriptTask-Adapter mit Fallback auf direkten Agent-Dispatch
- Softwareinventar je Gerät

## Wichtige Ehrlichkeit vorweg

Ich konnte in dieser Umgebung **nicht gegen deine exakte MeshCentral- und ScriptTask-Version live testen**.
Darum ist die Integration absichtlich so gebaut:

1. Es gibt einen **ScriptTask-Adapter**, der nach typischen Methoden sucht (`queueTask`, `createTask`, `dispatchScript`, `runTask`).
2. Wenn nichts Passendes gefunden wird, nutzt das Plugin einen **Fallback-Dispatch direkt an den Agenten**.
3. Dadurch ist die Basis lauffähig vorbereitet, aber vor Ort kann ein kleiner Namens-/Hook-Abgleich nötig sein.

## Ordnerstruktur

- `config.json` – Plugin-Metadaten
- `sworch.js` – Hauptplugin, API, Queue, Scheduling, UI-Routen
- `scripttask-adapter.js` – Integrationsschicht zu ScriptTask
- `db.js` – einfache persistente JSON-Datenbank
- `modules_meshcore/sworch-agent.js` – Agent-Helfer für Inventar und Skriptausführung
- `views/*` – moderne Oberfläche + Geräte-Tab

## Funktionen

### 1. Jobs

Ein Job speichert:
- Name/Beschreibung
- Script-Typ (`powershell` oder `shell`)
- Script-Inhalt
- Zeitplan
- Retry-Anzahl
- Ablaufdatum

### 2. Bulk-Zuweisung

Im Reiter **Bulk-Zuweisung** kannst du:
- mehrere Geräte markieren
- mehrere Jobs markieren
- alles in einem Schritt zuweisen
- optional sofort in die Queue legen

### 3. Queue / Offline-Verhalten

Runs bleiben persistent im JSON-Store liegen.
Wenn ein Agent offline ist, schlägt der Job nicht einfach fehl, sondern bleibt `queued`.
Sobald der Agent online ist, wird der Run abgearbeitet.

### 4. OnConnect

Jobs mit `schedule.mode = onConnect` werden bei jeder Agent-Verbindung automatisch gequeued.

### 5. Softwareinventar

Beim Agent-Connect fordert das Plugin ein Inventar an.
Der MeshCore-Helfer sammelt:

- unter Windows: Registry-Uninstall-Keys
- unter Linux: `dpkg-query` oder `rpm -qa`

## Installation

### Plugin aktivieren

In MeshCentral muss die Plugin-Funktion aktiviert sein.

### Plugin ablegen

Den Ordner `meshcentral-software-orchestrator-v2` in das Plugin-Verzeichnis deiner Instanz kopieren.

### Server neu starten

Danach MeshCentral neu starten.

## Erwartete Nacharbeit vor Ort

Der wichtigste Punkt ist der ScriptTask-Abgleich.
Falls dein ScriptTask-Plugin intern andere Methodennamen nutzt, musst du in `scripttask-adapter.js` genau diese Methode ergänzen.

Beispiel:

```js
() => typeof host.meineInterneMethode === 'function' && host.meineInterneMethode(payload)
```

## API-Endpunkte

- `GET /plugins/sworch/api/meta`
- `GET /plugins/sworch/api/dashboard`
- `GET /plugins/sworch/api/devices`
- `GET /plugins/sworch/api/jobs`
- `GET /plugins/sworch/api/runs`
- `GET /plugins/sworch/api/inventory`
- `POST /plugins/sworch/api/jobs`
- `POST /plugins/sworch/api/assignments`
- `POST /plugins/sworch/api/jobs/queue`
- `POST /plugins/sworch/api/runs/update`
- `POST /plugins/sworch/api/inventory/update`

## Nächste sinnvolle Ausbaustufe

Für „fast produktionsreif“ würde ich als Nächstes ergänzen:

1. Rechte-/Rollenprüfung pro Benutzer
2. Job-Editor mit Variablen und Vorlagen
3. Filter „Geräte ohne Software X“
4. echte Ergebnisrückführung direkt aus MeshCentral-Events statt nur über Adapter/Fallback
5. CRUD für Job-Bearbeitung/Löschen
6. optional Upload von Installationsdateien zusätzlich zu Skripten
