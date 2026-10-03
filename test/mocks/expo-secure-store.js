// In-memory mock of expo-secure-store for jest. Validates the key format like
// the real module and allows simulating failures for migration tests.
const store = new Map();
const calls = [];
let failures = { get: 0, set: 0, delete: 0 };
let corruptReads = false;
let interceptor = null;

const KEY_RE = /^[\w.-]+$/;

function check(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error('Invalid key provided to SecureStore.');
  }
}

function maybeFail(op) {
  if (interceptor) interceptor(op);
  if (failures[op] > 0) {
    failures[op]--;
    throw new Error(`SecureStore ${op} failed (mock)`);
  }
}

module.exports = {
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  ALWAYS: 2,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 3,
  ALWAYS_THIS_DEVICE_ONLY: 4,
  WHEN_UNLOCKED: 5,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  isAvailableAsync: async () => true,
  getItemAsync: async (key, options) => {
    check(key);
    calls.push({ op: 'get', key, options });
    maybeFail('get');
    const value = store.has(key) ? store.get(key) : null;
    return corruptReads && value !== null ? value + 'x' : value;
  },
  setItemAsync: async (key, value, options) => {
    check(key);
    calls.push({ op: 'set', key, options });
    maybeFail('set');
    if (typeof value !== 'string') throw new Error('Invalid value provided to SecureStore.');
    store.set(key, value);
  },
  deleteItemAsync: async (key, options) => {
    check(key);
    calls.push({ op: 'delete', key, options });
    maybeFail('delete');
    store.delete(key);
  },
  // --- test helpers ---
  __store: store,
  __calls: calls,
  __reset() {
    store.clear();
    calls.length = 0;
    failures = { get: 0, set: 0, delete: 0 };
    corruptReads = false;
    interceptor = null;
  },
  /** Called before every operation; may throw (simulates a process crash). */
  __setInterceptor(fn) {
    interceptor = fn;
  },
  __failNext(op, times = 1) {
    failures[op] = times;
  },
  __setCorruptReads(value) {
    corruptReads = value;
  },
};
