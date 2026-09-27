const { withAppBuildGradle, createRunOncePlugin } = require('@expo/config-plugins');

/**
 * Добавляет release-подпись в генерируемый android/app/build.gradle.
 * Креды приезжают через переменные окружения (CI: .github/workflows/android-apk.yml):
 *   RELEASE_KEYSTORE_PATH / RELEASE_KEYSTORE_PASSWORD / RELEASE_KEY_ALIAS / RELEASE_KEY_PASSWORD
 * Без переменных release собирается debug-подписью — локальная сборка не ломается.
 */

const RELEASE_SIGNING_CONFIG = `        release {
            // Подпись из CI через env (.github/workflows/android-apk.yml)
            if (System.getenv("RELEASE_KEYSTORE_PATH")) {
                storeFile file(System.getenv("RELEASE_KEYSTORE_PATH"))
                storePassword System.getenv("RELEASE_KEYSTORE_PASSWORD")
                keyAlias System.getenv("RELEASE_KEY_ALIAS")
                keyPassword System.getenv("RELEASE_KEY_PASSWORD")
            }
        }
`;

// Шаблонный блок debug-подписи из expo-шаблона (android/app/build.gradle)
const DEBUG_BLOCK = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
`;

function apply(contents) {
  // Уже применён (повторный prebuild) — пропускаем
  if (contents.includes('RELEASE_KEYSTORE_PATH')) return contents;

  if (!contents.includes(DEBUG_BLOCK)) {
    throw new Error('withReleaseSigning: не найден шаблонный блок signingConfigs.debug');
  }
  let out = contents.replace(DEBUG_BLOCK, DEBUG_BLOCK + RELEASE_SIGNING_CONFIG);

  const releaseRe = /(buildTypes[\s\S]*?release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/;
  if (!releaseRe.test(out)) {
    throw new Error('withReleaseSigning: не найден signingConfig в buildTypes.release');
  }
  out = out.replace(
    releaseRe,
    '$1signingConfig System.getenv("RELEASE_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug',
  );
  return out;
}

module.exports = createRunOncePlugin(
  (config) =>
    withAppBuildGradle(config, (cfg) => {
      cfg.modResults.contents = apply(cfg.modResults.contents);
      return cfg;
    }),
  'with-release-signing',
  '1.0.0',
);
