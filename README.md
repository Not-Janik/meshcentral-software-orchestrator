# Software Orchestrator

This is a ScriptTask-style MeshCentral plugin prototype for software distribution.

## What works in this build
- device tab via `/pluginadmin.ashx?pin=sworch&user=1`
- server-side queue for offline devices
- create, edit, delete, assign and queue jobs
- per-device run history
- software inventory request and storage

## Notes
This is a practical fork-style prototype. It intentionally uses the same overall integration style as ScriptTask: `hasAdminPanel=false`, `handleAdminReq`, and `onDeviceRefreshEnd`.
