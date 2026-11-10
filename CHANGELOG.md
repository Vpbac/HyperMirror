# Changelog

## v1.0.5 — 2026-11-10

### Fixed
- Fixed periodic audio dropouts in the PC receiver AudioWorklet. The receiver now preserves remaining PCM samples when a 480-sample packet crosses the browser's 128-sample render quantum boundary, and outputs silence only for genuinely missing samples.

### Verification
- JavaScript syntax checks passed for `pc-receiver/server.js` and `pc-receiver/public/app.js`.
- Android debug APK build passed with `:app:assembleDebug`.
