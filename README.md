# MeshCentral Software Orchestrator

Plugin fuer MeshCentral mit Job-Queue, Zeitplanung, Bulk-Zuweisung und Softwareinventar.

## Hinweise
- Die UI-Anbindung orientiert sich am offiziellen MeshCentral-Plugin-Modell und am Verhalten von ScriptTask.
- Der Device-Tab wird ueber `onDeviceRefreshEnd` registriert.
- Die Admin-Seite laeuft ueber `handleAdminReq`.
- Jobs koennen direkt ueber den Agent-Fallback oder ueber einen erkannten ScriptTask-Host verschickt werden.

## Installation
1. Plugin in ein oeffentliches GitHub-Repo legen.
2. In MeshCentral Plugins aktivieren.
3. Das Repo ueber `My Server -> Plugins` importieren.
4. Plugin aktivieren und MeshCentral neu starten.

## Stand
Dies ist eine praktikable Hook-basierte Fassung, keine vollstaendige MDM-Suite. Die Kernfunktionen fuer Queue, Bulk, Scheduling und Inventar sind enthalten.
