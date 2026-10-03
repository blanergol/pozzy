const { withAppBuildGradle, createRunOncePlugin } = require('@expo/config-plugins');

/**
 * Adds a release signing config to the generated android/app/build.gradle.
 * Credentials come from environment variables (CI: .github/workflows/android-apk.yml):
 *   RELEASE_KEYSTORE_PATH / RELEASE_KEYSTORE_PASSWORD / RELEASE_KEY_ALIAS / RELEASE_KEY_PASSWORD
 * Without them, release is signed with the debug key — local builds keep working.
 */

const RELEASE_SIGNING_CONFIG = `        release {
            // Release signing from CI via env (.github/workflows/android-apk.yml)
            if (System.getenv("RELEASE_KEYSTORE_PATH")) {
                storeFile file(System.getenv("RELEASE_KEYSTORE_PATH"))
                storePassword System.getenv("RELEASE_KEYSTORE_PASSWORD")
                keyAlias System.getenv("RELEASE_KEY_ALIAS")
                keyPassword System.getenv("RELEASE_KEY_PASSWORD")
            }
        }
`;

// Debug signing block from the Expo template (android/app/build.gradle)
const DEBUG_BLOCK = `        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
`;

function apply(contents) {
  // Already applied (repeated prebuild) — skip
  if (contents.includes('RELEASE_KEYSTORE_PATH')) return contents;

  if (!contents.includes(DEBUG_BLOCK)) {
    throw new Error('withReleaseSigning: template block signingConfigs.debug not found');
  }
  let out = contents.replace(DEBUG_BLOCK, DEBUG_BLOCK + RELEASE_SIGNING_CONFIG);

  const releaseRe = /(buildTypes[\s\S]*?release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/;
  if (!releaseRe.test(out)) {
    throw new Error('withReleaseSigning: signingConfig not found in buildTypes.release');
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
