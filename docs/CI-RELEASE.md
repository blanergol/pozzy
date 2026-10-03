# CI/CD: checks and APK release

## Flow

1. **Push to `master` or a pull request** → the `ci.yml` workflow:
   typecheck (`npx tsc --noEmit`; the project has no separate ESLint) + unit tests (`npx jest`).

2. **A `v*` tag** → the `android-apk.yml` workflow: the same checks, then a build of
   a signed release APK, an `apksigner` signature check, the `pozzy-release-apk`
   artifact and publication of the APK to GitHub Releases (with auto-generated
   release notes).

Versions start at `v1.0.1`. To cut a release:

```bash
# bump version in app.json, then:
git tag v1.0.1
git push origin v1.0.1
```

`expo prebuild` takes the Android `versionName` from `expo.version` in `app.json`,
so the version in `app.json` and the tag must match.

## Signing

The APK is signed with a release key stored in the repository secrets. One-time setup:

1. Generate a keystore locally:
   ```bash
   keytool -genkeypair -v -storetype PKCS12 \
     -keystore release.keystore -alias pozzy-release \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Keep `release.keystore` and the passwords in a safe place: losing the key means
   you can no longer update the app (Android requires the same signature for every version).

2. Add the secrets (Settings → Secrets and variables → Actions):
   - `RELEASE_KEYSTORE_BASE64` — the output of `base64 -w0 release.keystore`;
   - `RELEASE_KEYSTORE_PASSWORD` — keystore password;
   - `RELEASE_KEY_ALIAS` — key alias (for example `pozzy-release`);
   - `RELEASE_KEY_PASSWORD` — key password.

3. On every build the workflow restores the keystore from the secret into a temporary
   file and passes the path and passwords to Gradle through environment variables. Since
   `android/` is in `.gitignore` (managed workflow), the native project is generated in CI
   by the `expo prebuild` step, and the signing config is injected by the config plugin
   `plugins/withReleaseSigning.js`: it writes `signingConfigs.release` (from env) into the
   freshly generated `android/app/build.gradle`. Without the env variables the release
   build falls back to the debug signature, so a local build
   (`npx expo run:android --variant release`) keeps working.

The `Verify APK signature` step prints the APK signing certificate to the build log, so
you can confirm that the release key was applied.

## Google Play (if ever needed)

Publishing to Google Play requires an AAB instead of an APK:

```yaml
- run: ./gradlew bundleRelease   # android/app/build/outputs/bundle/release/app-release.aab
```
