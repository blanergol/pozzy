# CI/CD: сборка release-APK для Android

Workflow: `.github/workflows/android-apk.yml`. Собирает подписанный `app-release.apk` на
`ubuntu-latest` (JDK 17 + Android SDK уже предустановлены на раннере).

## Триггеры

- push в `master` — сборка, APK в артефактах запуска (Actions → запуск → Artifacts);
- тег `v*` (например `git tag v1.0.0 && git push origin v1.0.0`) — сборка + публикация APK в GitHub Releases;
- ручной запуск: Actions → Android APK → Run workflow.

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
