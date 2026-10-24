// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), readable by the container user only (0600):
// - the stop after the gateway refused the user name and password, or after
//   its certificate changed, with the place it belongs to: a restart never
//   sends refused credentials again, nor the password to another certificate;
// - the certificate fingerprint pinned for that place (public data);
// - the time of the last connection attempt (a restart loop never connects
//   faster than the spacing).
// Never the user name, the password, nor anything derived from them.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';

export const STATE_FILE = '/data/sunricher-dali-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    saves: 0,
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      this.saves += 1;
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

export const STOP_KINDS = ['credentials_refused', 'certificate_changed'];

const HEX64 = /^[0-9a-f]{64}$/;
const place = (value) => typeof value === 'string' && value.length > 0 && value.length <= 400;

/** The persisted state, repaired: { stop, pin, lastAttemptAt }. */
export function normalizeMemory(raw) {
  const stop = raw?.stop;
  const pin = raw?.pin;
  return {
    stop:
      place(stop?.place) && STOP_KINDS.includes(stop?.kind)
        ? {
            place: stop.place,
            kind: stop.kind,
            at: Number.isFinite(stop.at) ? stop.at : 0,
            ...(HEX64.test(stop.presented ?? '') ? { presented: stop.presented } : {}),
          }
        : null,
    pin:
      place(pin?.place) && HEX64.test(pin?.fingerprint ?? '')
        ? { place: pin.place, fingerprint: pin.fingerprint }
        : null,
    lastAttemptAt: Number.isFinite(raw?.lastAttemptAt) ? raw.lastAttemptAt : 0,
  };
}
