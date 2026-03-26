# Changelog

## 0.4.0
- ScriptTask-style integration via `handleAdminReq` and `onDeviceRefreshEnd`
- distinct job list/editor layout
- create, edit, delete, queue jobs
- offline queue persisted on server
- inventory refresh and per-device view
- safer ES5 meshcore agent helper


## 1.0.2
- Fixed MeshCore export so `consoleaction` is actually exposed to the agent runtime.
- This addresses `TypeError: undefined not callable (property 'consoleaction')`.
