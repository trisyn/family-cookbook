// A fixed device-retention deadline. Token refreshes never extend the 30 days.
export function createLoginStorage(local, session, now = () => Date.now()) {
  let remember = false;
  let rememberUntil = null;
  return {
    get deadline() { return rememberUntil; },
    prepare(rememberDevice) {
      remember = Boolean(rememberDevice);
      rememberUntil = remember ? now() + 30 * 24 * 60 * 60 * 1000 : null;
    },
    getItem(key) {
      const temporary = session.getItem(key);
      if (temporary !== null) return temporary;
      const stored = local.getItem(key);
      if (stored === null) return null;
      try {
        const entry = JSON.parse(stored);
        if (typeof entry.value !== 'string' || !Number.isFinite(entry.expiresAt)) {
          local.removeItem(key); return null;
        }
        rememberUntil = entry.expiresAt;
        remember = true;
        if (now() >= rememberUntil) { local.removeItem(key); return null; }
        return entry.value;
      } catch { local.removeItem(key); return null; }
    },
    setItem(key, value) {
      if (remember) {
        if (!rememberUntil || now() >= rememberUntil) {
          local.removeItem(key); session.removeItem(key); return;
        }
        local.setItem(key, JSON.stringify({ value, expiresAt: rememberUntil }));
        session.removeItem(key);
      } else {
        session.setItem(key, value);
        local.removeItem(key);
      }
    },
    removeItem(key) { local.removeItem(key); session.removeItem(key); }
  };
}
