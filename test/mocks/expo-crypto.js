// expo-crypto mock for jest: CSPRNG from Node.
const nodeCrypto = require('crypto');

module.exports = {
  getRandomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  getRandomBytesAsync: async (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  getRandomValues: (array) => nodeCrypto.getRandomValues(array),
};
