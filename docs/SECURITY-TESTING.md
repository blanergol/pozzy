# Manual checklist: secrets in SecureStore and encryption of offline data

The automated tests (`npx jest src/storage src/data`) cover the logic on mocks. This checklist
covers what the mocks cannot catch: the real Keychain/Keystore, the real AsyncStorage,
an update installed over the previous release, and backups.

## Preparation

- Both builds must be **debuggable**, otherwise `run-as` cannot read the app data.
  Build the previous release from its tag:

  ```bash
  git checkout v1.0.7 && npm ci && npx expo run:android   # old version
  git checkout <branch> && npm ci && npx expo prebuild --clean && npx expo run:android   # new version
  ```

  `prebuild --clean` is required so that the expo-secure-store plugin writes the backup rules
  into `AndroidManifest.xml` (the `android/` directory is generated and not kept in git).
- Use recognizable markers that are easy to grep for as plain text later:
  password `PWD-MARKER-1`, API key `sk-MARKER-2`, note text `NOTE-MARKER-3`,
  offline edit `EDIT-MARKER-4`, an attachment file containing `FILE-MARKER-5`.

Dumping AsyncStorage (Android):

```bash
adb exec-out run-as com.pozzy.mobile cat databases/RKStorage > RKStorage.db
sqlite3 RKStorage.db "select key, substr(value, 1, 60) from catalystLocalStorage"
grep -a -c -E "MARKER" RKStorage.db            # expected: 0
adb shell run-as com.pozzy.mobile ls -R files/pending-attachments
```

iOS Simulator: the data lives in
`$(xcrun simctl get_app_container booted com.pozzy.mobile data)/Library/Application Support/`;
grep for the markers there: `grep -r -a MARKER "<path>"`.

## 1. Main scenario: upgrade with pending offline edits

- [ ] Install **v1.0.7**, add a server with the password `PWD-MARKER-1`, set the key `sk-MARKER-2` in the AI settings.
- [ ] Open a few notes online (they land in the cache), add `NOTE-MARKER-3` to one of them, wait for the sync.
- [ ] Send a couple of messages in the AI chat.
- [ ] Turn on airplane mode. Edit a note (`EDIT-MARKER-4`), create a new one, attach a file containing `FILE-MARKER-5`.
- [ ] Confirm that in the old version the markers are visible in `RKStorage.db` (sanity check of the method).
- [ ] Still in airplane mode, install the new build over it (`npx expo run:android`) and launch it.
- [ ] The app opens without asking for the password again, the offline banner is there, the edits and the new note are visible.
- [ ] Turn airplane mode off: the edits, the new note and the attachment reach the server (check in the Poznote web UI), no duplicates.
- [ ] `grep -a -c MARKER RKStorage.db` → `0`. `RKStorage` contains `pozzy.migration.v1 = 1`, the `pozzy.cache.*` values start with `enc:v1:`, `poznote.servers.v1` has no `password` field, `poznote.aiSettings.v1` has no `apiKey`.
- [ ] No plain-text files are left in `files/pending-attachments/` (until the attachment is uploaded there is only `<id>/<opId>.enc`).
- [ ] The AI chat history and the custom templates are still there after a restart.

## 2. Interrupted migration

- [ ] Repeat steps 1–4 of scenario 1 on v1.0.7, install the new build and kill the process right after the splash screen appears (`adb shell am force-stop com.pozzy.mobile`); repeat 2–3 times.
- [ ] Launch normally: data and offline edits are intact, everything syncs once online, no markers in `RKStorage.db`.

## 3. Lost data key

- [ ] In the new build, make an edit in airplane mode (the queue is not empty).
- [ ] Delete the SecureStore: `adb shell run-as com.pozzy.mobile rm shared_prefs/SecureStore.xml`, restart the app.
- [ ] The app does not crash; after unlocking, the message "Offline changes could not be restored" with the server name is shown once; it does not appear on the next launch.
- [ ] The server password has to be entered again in Settings; after that, notes load from the server.
- [ ] Repeat without unsynced edits: no message, the cache is simply reloaded.

## 4. Backup and fresh install

- [ ] Android: `adb shell dumpsys package com.pozzy.mobile | grep -i backup` — the app has `fullBackupContent`/`dataExtractionRules` from secure-store.
- [ ] `adb shell bmgr backupnow com.pozzy.mobile`, uninstall the app, install it again, `adb shell bmgr restore com.pozzy.mobile` (or restore through a Google account on another device): the app starts as a clean install, no crashes.
- [ ] iOS: uninstall and reinstall the app — onboarding, no servers, the old password is not picked up (Keychain leftovers are deleted on first start).

## 5. Removing a server

- [ ] Add a second server, open notes on it, queue an attachment in airplane mode.
- [ ] Delete the profile in Settings: `pozzy.cache.<id>.*` are gone from `RKStorage`, there is no `<id>` directory in `files/pending-attachments/`, and the password is not pre-filled when the same server is added again.

## 6. Biometrics and background

- [ ] Enable the app lock, send the app to the background for 30+ seconds, unlock: data is readable.
- [ ] Add or remove a fingerprint in the system settings: after unlocking, data and passwords are intact (keys are not bound to biometrics).
- [ ] The lost-edits message (scenario 3) does not appear on top of the lock screen, only after unlocking.

## 7. Web

- [ ] `npm run web`: add a server, work with notes — everything works as before.
- [ ] DevTools → Application → Local Storage contains no password, API key, note text or chat history.
- [ ] After a page reload the password has to be entered again (expected behavior).
- [ ] Upgrade from the previous web version with unsynced edits: the edits stay in `localStorage` until they are synced and disappear afterwards.
