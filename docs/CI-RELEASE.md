# CI/CD: проверки и релиз APK

## Flow

1. **Push в `master` или pull request** → workflow `ci.yml`:
   typecheck (`npx tsc --noEmit`, отдельного ESLint в проекте нет) + unit-тесты (`npx jest`).

2. **Тег `v*`** → workflow `android-apk.yml`: те же проверки, затем сборка
   подписанного release-APK, проверка подписи `apksigner`, артефакт
   `pozzy-release-apk` и публикация APK в GitHub Releases (с автогенерацией
   release notes).

Версии ведём с `v1.0.1`. Выпуск релиза:

```bash
# поднять version в app.json, затем:
git tag v1.0.1
git push origin v1.0.1
```

`expo prebuild` берёт `versionName` для Android из `expo.version` в `app.json`,
поэтому версия в `app.json` и тег должны совпадать.

## Подпись

APK подписывается release-ключом из секретов репозитория. Настройка (один раз):

1. Сгенерировать keystore локально:
   ```bash
   keytool -genkeypair -v -storetype PKCS12 \
     -keystore release.keystore -alias pozzy-release \
     -keyalg RSA -keysize 2048 -validity 10000
   ```
   Сохраните `release.keystore` и пароли в надёжном месте: потеря ключа = невозможность
   обновлять приложение (Android требует одну подпись для всех версий).

2. Добавить секреты (Settings → Secrets and variables → Actions):
   - `RELEASE_KEYSTORE_BASE64` — вывод `base64 -w0 release.keystore`;
   - `RELEASE_KEYSTORE_PASSWORD` — пароль хранилища;
   - `RELEASE_KEY_ALIAS` — алиас ключа (например `pozzy-release`);
   - `RELEASE_KEY_PASSWORD` — пароль ключа.

3. Workflow на каждой сборке восстанавливает keystore из секрета во временный файл и
   передаёт путь/пароли в Gradle через env. Поскольку `android/` в `.gitignore`
   (managed workflow), нативный проект генерируется в CI шагом `expo prebuild`, а
   подпись подставляет конфиг-плагин `plugins/withReleaseSigning.js`: он вписывает
   `signingConfigs.release` (из env) в свежий `android/app/build.gradle`.
   Без env-переменных release собирается debug-подписью — локальная сборка
   (`npx expo run:android --variant release`) не ломается.

Шаг `Verify APK signature` печатает сертификат подписи APK в лог сборки — по нему можно
сверить, что приложен именно release-ключ.

## Google Play (если понадобится)

Для публикации в Google Play нужен AAB вместо APK:

```yaml
- run: ./gradlew bundleRelease   # android/app/build/outputs/bundle/release/app-release.aab
```
