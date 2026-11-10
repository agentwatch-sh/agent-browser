// The page reader. chrome.scripting.executeScript injects readPageState into a
// tab with `func:`, after `files: ["lib/codec.js"]` has set
// globalThis.agentwatchCodec. Chrome serializes only the function, so it must
// use nothing from this module: every helper is declared inside it.
//
// readPageState(limit, expectOrigin) returns one JSON string, because Chrome
// converts an object result to its own value type, which sorts object keys
// (measured on Chromium 156), and a page's stored objects keep their key
// order. The string holds one of:
//
// - {origin, storage, skipped}: `storage` is the C2 storage object. `skipped`
//   lists what was left out: databases and caches that could not be opened or
//   read, and the opaque entries of a cache (status 0: the page itself cannot
//   read their bytes).
// - {origin, tooLarge: {stage, bytes, largest}}: the state passes `limit`
//   bytes, and nothing else was kept. stage "estimate": the site's IndexedDB
//   on disk (bytes) is more than ESTIMATE_FACTOR times the limit, and nothing
//   was read. stage "read": the encoded output passed the limit; largest is
//   the largest database or cache read so far ({kind, name, bytes}) or null.
// - {origin} alone, when the tab no longer shows expectOrigin: nothing read.
//
// The memory a read holds stays near `limit`: records are read with a cursor
// in batches of about BATCH_BYTES (a batch also stops once the strings and
// buffers of its records reach BATCH_BYTES), a running count of the encoded
// output stops the read at the limit, the codec gets the remaining bytes as its
// budget, and a cache body is read as a stream that stops at the remaining bytes.
//
// A name is not secret; a stored value never enters an error or a name.
export async function readPageState(limit = 33554432, expectOrigin = null) {
  const origin = location.origin;
  if (typeof expectOrigin === "string" && origin !== expectOrigin) return JSON.stringify({ origin });

  // On-disk size is not the encoded size: values are compressed on disk, and
  // a database file can keep space that deleted records left. Below 16 times
  // the limit, the running count decides; the margin only saves the time of
  // reading up to the limit before the refusal. IndexedDB's own usage is
  // used when Chrome gives it, so a site's Cache Storage padding and its
  // file system (never sent) do not count.
  const ESTIMATE_FACTOR = 16;
  const BATCH_FIRST = 16;
  const BATCH_MAX = 512;
  const BATCH_BYTES = 4 * 1048576;

  const codec = globalThis.agentwatchCodec;
  const CHUNK = 32 * 1024;
  const encoder = new TextEncoder();
  const sizeOf = (x) => encoder.encode(JSON.stringify(x)).length;
  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(s);
  };
  const readArea = (area) => {
    const out = {};
    try {
      for (let i = 0; i < area.length; i++) {
        const k = area.key(i);
        const v = area.getItem(k);
        if (k !== null && v !== null) {
          Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
        }
      }
    } catch {
      // A storage area that the page forbids reads as empty.
    }
    return out;
  };
  const isTooLarge = (e) => e !== null && typeof e === "object" && e.t === "unsupported" && e.c === "TooLarge";

  // The running count of the encoded output, and the parts read so far.
  let used = 0;
  const parts = [];
  const tooLarge = (stage, bytes) => {
    let largest = null;
    for (const p of parts) if (largest === null || p.bytes > largest.bytes) largest = p;
    return JSON.stringify({ origin, tooLarge: { stage, bytes, largest } });
  };
  // Adds n bytes to the count (and to a part); false once past the limit.
  const add = (part, n) => {
    used += n;
    if (part) part.bytes += n;
    return used <= limit;
  };
  // A value or a body that alone passes the bytes left: the state is too large.
  const overflow = (part) => {
    add(part, limit - used + 1);
    return tooLarge("read", used);
  };
  // A database or a cache that fails part way is left out, and so is its count.
  const dropPart = (part) => {
    used -= part.bytes;
    part.bytes = 0;
    parts.splice(parts.indexOf(part), 1);
  };

  try {
    const est = await navigator.storage.estimate();
    const details = est && est.usageDetails;
    const onDisk = details && typeof details.indexedDB === "number" ? details.indexedDB : est && est.usage;
    if (typeof onDisk === "number" && onDisk > limit * ESTIMATE_FACTOR) return tooLarge("estimate", onDisk);
  } catch {
    // No estimate: the running count still holds.
  }

  const storage = { local: readArea(localStorage), session: readArea(sessionStorage), idb: [], caches: [] };
  const skipped = [];
  if (!add(null, sizeOf(storage.local) + sizeOf(storage.session))) return tooLarge("read", used);

  // Opens a database that indexedDB.databases() listed. Without a version,
  // open() creates a database that is gone by now: the upgrade is aborted, so
  // nothing is created, and the database counts as gone (null).
  const openExisting = (name) =>
    new Promise((resolve, reject) => {
      let gone = false;
      const r = indexedDB.open(name);
      r.onupgradeneeded = () => {
        gone = true;
        try {
          r.transaction.abort();
        } catch {
          // The open then fails or succeeds below; either way nothing is read.
        }
      };
      r.onsuccess = () => {
        if (!gone) return resolve(r.result);
        try {
          r.result.close();
        } catch {
          // Already closed.
        }
        resolve(null);
      };
      r.onerror = () => (gone ? resolve(null) : reject(new Error("open failed")));
    });

  // The memory a read key or value holds, near enough, up to `cap`: NODE bytes
  // for each value in it (as the codec charges), plus its strings and the whole
  // buffer of each buffer or view (a structured clone keeps the whole buffer).
  // It stops counting at `cap`, also part way through a large or sparse array.
  // A Blob counts NODE: its bytes stay on disk until the codec reads them,
  // within its budget.
  const NODE = 12;
  const heldBytes = (x, cap) => {
    let n = NODE;
    const seen = new Set();
    const todo = [x];
    const push = (y) => {
      n += NODE;
      todo.push(y);
      return n < cap;
    };
    while (todo.length > 0 && n < cap) {
      const v = todo.pop();
      if (typeof v === "string") n += v.length;
      if (v === null || typeof v !== "object" || seen.has(v)) continue;
      seen.add(v);
      if (v instanceof ArrayBuffer) n += v.byteLength;
      else if (ArrayBuffer.isView(v)) {
        if (!seen.has(v.buffer)) n += v.buffer.byteLength;
        seen.add(v.buffer);
      }
      else if (v instanceof Map) {
        for (const [k, y] of v) if (!push(k) || !push(y)) break;
      } else if (v instanceof Set || Array.isArray(v)) {
        for (const y of v) if (!push(y)) break;
      } else {
        for (const k in v) if (Object.hasOwn(v, k) && (!push(k) || !push(v[k]))) break;
      }
    }
    return n;
  };

  // Up to `count` records after the key `after` (all from the first when
  // `after` is null), with one cursor in one transaction: a key and its value
  // always come together. The batch also ends once its records hold `room`
  // bytes (heldBytes), so large records after small ones never fill a batch
  // that the small ones sized. The transaction ends when the batch is full.
  const readBatch = (db, storeName, after, count, room) =>
    new Promise((resolve, reject) => {
      const st = db.transaction(storeName, "readonly").objectStore(storeName);
      const r = st.openCursor(after === null ? null : IDBKeyRange.lowerBound(after.key, true));
      const rows = [];
      let held = 0;
      r.onsuccess = () => {
        try {
          const c = r.result;
          if (!c) return resolve({ rows, done: true });
          rows.push([c.key, c.value]);
          held += heldBytes(c.key, room - held);
          held += heldBytes(c.value, room - held);
          if (rows.length >= count || held >= room) return resolve({ rows, done: false });
          c.continue();
        } catch {
          reject(new Error("read failed"));
        }
      };
      r.onerror = () => reject(new Error("request failed"));
    });

  let infos = [];
  try {
    infos = await indexedDB.databases();
  } catch {
    infos = [];
  }
  for (const info of infos) {
    const name = info.name;
    const part = { kind: "database", name: String(name), bytes: 0 };
    parts.push(part);
    let db = null;
    try {
      db = await openExisting(name);
      if (db === null) {
        dropPart(part);
        continue;
      }
      const d = { name: db.name, version: db.version, stores: [] };
      if (!add(part, sizeOf(d))) return tooLarge("read", used);
      for (const storeName of Array.from(db.objectStoreNames)) {
        const st = db.transaction(storeName, "readonly").objectStore(storeName);
        const s = {
          name: storeName,
          keyPath: st.keyPath === undefined ? null : st.keyPath,
          autoIncrement: st.autoIncrement,
          indexes: [],
          records: [],
        };
        for (const indexName of Array.from(st.indexNames)) {
          const ix = st.index(indexName);
          s.indexes.push({ name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry });
        }
        if (!add(part, sizeOf(s))) return tooLarge("read", used);
        // Batches of about BATCH_BYTES of output (never more than the bytes
        // left can hold); the first batch is small, and each next one is
        // sized by the records of the one before.
        let after = null;
        let count = BATCH_FIRST;
        for (;;) {
          const { rows, done } = await readBatch(db, storeName, after, count, Math.min(BATCH_BYTES, limit - used));
          let batchBytes = 0;
          for (const [k, v] of rows) {
            const key = await codec.encode(k, { budget: limit - used });
            if (isTooLarge(key)) return overflow(part);
            const value = await codec.encode(v, { budget: limit - used - sizeOf(key) });
            if (isTooLarge(value)) return overflow(part);
            const rec = { key, value };
            const n = sizeOf(rec) + 1;
            batchBytes += n;
            if (!add(part, n)) return tooLarge("read", used);
            s.records.push(rec);
          }
          if (done || rows.length === 0) break;
          after = { key: rows[rows.length - 1][0] };
          const perRecord = Math.max(1, batchBytes / rows.length);
          const room = Math.min(BATCH_BYTES, limit - used);
          count = Math.max(1, Math.min(BATCH_MAX, Math.floor(room / perRecord) + 1));
        }
        d.stores.push(s);
      }
      storage.idb.push(d);
    } catch {
      dropPart(part);
      skipped.push(String(name));
    } finally {
      try {
        if (db) db.close();
      } catch {
        // Already closed.
      }
    }
  }

  // A body as bytes, or null once it passes max bytes (the stream stops there).
  const readBody = async (resp, max) => {
    if (!resp.body || typeof resp.body.getReader !== "function") {
      const u8 = new Uint8Array(await resp.arrayBuffer());
      return u8.length > max ? null : u8;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  };

  let cacheNames = [];
  try {
    cacheNames = await caches.keys();
  } catch {
    cacheNames = [];
  }
  for (const name of cacheNames) {
    const part = { kind: "cache", name: String(name), bytes: 0 };
    parts.push(part);
    try {
      const cache = await caches.open(name);
      const entries = [];
      let opaque = 0;
      for (const r of await cache.keys()) {
        const resp = await cache.match(r);
        if (!resp) continue;
        if (resp.status === 0) {
          opaque += 1;
          continue;
        }
        const bytes = await readBody(resp, Math.floor(((limit - used) * 3) / 4));
        if (bytes === null) return overflow(part);
        const e = { url: r.url, status: resp.status, headers: Array.from(resp.headers), body: toB64(bytes) };
        if (!add(part, sizeOf(e) + 1)) return tooLarge("read", used);
        entries.push(e);
      }
      storage.caches.push({ name, entries });
      if (opaque > 0) skipped.push(opaque + " opaque entries of cache " + String(name));
    } catch {
      dropPart(part);
      skipped.push("cache " + String(name));
    }
  }
  return JSON.stringify({ origin, storage, skipped });
}
