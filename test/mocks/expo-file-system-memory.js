// In-memory mock of expo-file-system/legacy for attachment encryption tests.
// Files are stored as Buffer; directories are implicit, by path prefix.
const files = new Map();
let failWrite = null;

const EncodingType = { UTF8: 'utf8', Base64: 'base64' };

module.exports = {
  documentDirectory: 'file:///doc/',
  cacheDirectory: 'file:///cache/',
  EncodingType,
  async readAsStringAsync(uri, options = {}) {
    const buf = files.get(uri);
    if (!buf) throw new Error('File does not exist');
    return options.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
  },
  async writeAsStringAsync(uri, content, options = {}) {
    if (failWrite && failWrite(uri)) throw new Error('write failed (mock)');
    files.set(uri, Buffer.from(content, options.encoding === 'base64' ? 'base64' : 'utf8'));
  },
  async deleteAsync(uri, options = {}) {
    const dir = uri.endsWith('/') ? uri : `${uri}/`;
    let found = files.delete(uri);
    for (const key of [...files.keys()]) {
      if (key.startsWith(dir)) {
        files.delete(key);
        found = true;
      }
    }
    if (!found && !options.idempotent) throw new Error('File does not exist');
  },
  async makeDirectoryAsync() {},
  async copyAsync({ from, to }) {
    const buf = files.get(from);
    if (!buf) throw new Error('File does not exist');
    files.set(to, Buffer.from(buf));
  },
  async getInfoAsync(uri) {
    if (files.has(uri)) return { exists: true, isDirectory: false, uri, size: files.get(uri).length };
    const dir = uri.endsWith('/') ? uri : `${uri}/`;
    const isDir = [...files.keys()].some((k) => k.startsWith(dir));
    return isDir ? { exists: true, isDirectory: true, uri } : { exists: false, isDirectory: false, uri };
  },
  async readDirectoryAsync(uri) {
    const dir = uri.endsWith('/') ? uri : `${uri}/`;
    const names = new Set();
    for (const key of files.keys()) {
      if (key.startsWith(dir)) names.add(key.slice(dir.length).split('/')[0]);
    }
    return [...names];
  },
  // --- test helpers ---
  __files: files,
  __reset() {
    files.clear();
    failWrite = null;
  },
  /** predicate(uri) → true: writing to this path fails. */
  __failWrites(predicate) {
    failWrite = predicate;
  },
};
