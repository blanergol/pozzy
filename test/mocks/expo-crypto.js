// Мок expo-crypto для jest: CSPRNG из Node.
const nodeCrypto = require('crypto');

module.exports = {
  getRandomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  getRandomBytesAsync: async (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  getRandomValues: (array) => nodeCrypto.getRandomValues(array),
};
