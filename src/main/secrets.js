// Secrets (Gemini key, Freesia Cloud token, local server key) are
// encrypted with Electron safeStorage (Windows DPAPI, bound to the user
// account) and never handed to the renderer.
const { safeStorage } = require('electron');

function createSecrets(store) {
  const canEncrypt = () => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  };

  function get(name) {
    const raw = store.get(`secrets.${name}`);
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
      try { return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')); }
      catch { return ''; }
    }
    if (!raw.startsWith('plain:')) return '';
    // Stored before encryption was available (it only is after app ready): upgrade it now
    const value = raw.slice(6);
    if (canEncrypt()) set(name, value);
    return value;
  }

  function set(name, value) {
    if (!value) { store.delete(`secrets.${name}`); return; }
    const packed = canEncrypt()
      ? 'enc:' + safeStorage.encryptString(String(value)).toString('base64')
      : 'plain:' + String(value);
    store.set(`secrets.${name}`, packed);
  }

  // 2.x kept the Gemini key in plain text under "apiKey"; move it once.
  function migrate() {
    const legacy = store.get('apiKey');
    if (legacy && !get('gemini')) set('gemini', legacy);
    if (legacy !== undefined) store.delete('apiKey');
  }

  return { get, set, migrate, has: (name) => !!get(name) };
}

module.exports = { createSecrets };
