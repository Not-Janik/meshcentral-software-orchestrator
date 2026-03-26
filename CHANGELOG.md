# Changelog

## 0.3.0
- Plugin-Integration auf MeshCentral-Hook-Basis neu aufgebaut
- Admin-Seite jetzt ueber `handleAdminReq` statt eigener Express-Route
- Device-Tab jetzt im ScriptTask-Stil ueber `/pluginadmin.ashx?pin=sworch&user=1`
- Persistente Queue, Bulk-Zuweisung, einfache Zeitplaene und Inventaransicht integriert
- Fallback auf direkten Agent-Dispatch, wenn kein ScriptTask-Host gefunden wird
