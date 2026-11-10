// Tagged value codec for page storage (IndexedDB keys and values). Classic
// script: it sets globalThis.agentwatchCodec and exports nothing else. Loaded
// by a Node test, by chrome.scripting.executeScript in a page's isolated world
// and by a module service worker. encode(value, {budget}) is async, decode is
// sync. No error text carries a stored value.
(() => {
  class UnsupportedValue extends Error {
    constructor(message) {
      super(message);
      this.name = "UnsupportedValue";
    }
  }

  const VIEWS = [
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
    "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
    "BigInt64Array", "BigUint64Array", "DataView",
  ];
  const CHUNK = 32 * 1024;

  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(s);
  };

  const fromB64 = (b64) => {
    let bin;
    try {
      bin = atob(b64);
    } catch {
      throw new UnsupportedValue("invalid base64");
    }
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };

  const ctorName = (v) => {
    try {
      const p = Object.getPrototypeOf(v);
      const n = p && p.constructor && p.constructor.name;
      return typeof n === "string" && n ? n : "Object";
    } catch {
      return "Object";
    }
  };

  // The built-in view kind of v, or null. A subclass (a Node Buffer) maps to
  // its built-in base.
  const viewName = (v) => {
    for (const n of VIEWS) {
      const C = globalThis[n];
      if (C && v instanceof C) return n;
    }
    return null;
  };

  const hasBlob = typeof Blob === "function";
  const hasFile = typeof File === "function";

  // The optional budget (opts.budget, in bytes) bounds the encoded output: a
  // value whose encoding would pass it encodes as {t: "unsupported", c:
  // "TooLarge"} as a whole. A value that shares one object many times (a
  // structured clone keeps shared references; the encoding is a tree) cannot
  // grow past it. The cost of each node is a lower bound of its JSON size, and
  // a blob or a buffer is charged before its bytes are read. Without a budget
  // nothing is counted.
  class OverBudget {}
  const b64Length = (n) => Math.ceil(n / 3) * 4;
  const NODE = 12; // {"t":"x","v":} and a separator, at least

  function charge(meter, n) {
    if (meter === null) return;
    meter.left -= n;
    if (meter.left < 0) throw new OverBudget();
  }

  async function encode(v, opts) {
    const budget = opts && typeof opts.budget === "number" ? opts.budget : null;
    const meter = budget === null ? null : { left: budget };
    try {
      return await enc(v, new Set(), meter);
    } catch (e) {
      if (e instanceof OverBudget) return { t: "unsupported", c: "TooLarge" };
      throw e;
    }
  }

  async function enc(v, path, meter) {
    charge(meter, NODE);
    if (v === undefined) return { t: "undef" };
    if (v === null || typeof v === "boolean") return { t: "j", v };
    if (typeof v === "string") {
      charge(meter, v.length);
      return { t: "j", v };
    }
    if (typeof v === "number") {
      if (Object.is(v, -0)) return { t: "num", v: "-0" };
      return Number.isFinite(v) ? { t: "j", v } : { t: "num", v: String(v) };
    }
    if (typeof v === "bigint") {
      const s = v.toString();
      charge(meter, s.length);
      return { t: "big", v: s };
    }
    if (typeof v === "function") return { t: "unsupported", c: "Function" };
    if (typeof v === "symbol") return { t: "unsupported", c: "Symbol" };
    if (v instanceof Date) {
      const ms = v.getTime();
      return { t: "date", v: Number.isNaN(ms) ? null : ms };
    }
    if (hasBlob && v instanceof Blob) {
      charge(meter, b64Length(v.size) + v.type.length);
      const out = { t: "blob", type: v.type, v: toB64(new Uint8Array(await v.arrayBuffer())) };
      if (hasFile && v instanceof File) {
        charge(meter, v.name.length);
        out.name = v.name;
        out.lastModified = v.lastModified;
      }
      return out;
    }
    if (v instanceof ArrayBuffer) {
      charge(meter, b64Length(v.byteLength));
      return { t: "ab", v: toB64(new Uint8Array(v)) };
    }
    if (ArrayBuffer.isView(v)) {
      const c = viewName(v);
      if (c === null) return { t: "unsupported", c: ctorName(v) };
      charge(meter, b64Length(v.byteLength));
      return { t: "view", c, v: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    }
    if (v instanceof RegExp) {
      charge(meter, v.source.length + v.flags.length);
      return { t: "re", s: v.source, f: v.flags };
    }
    const proto = Object.getPrototypeOf(v);
    const plain = proto === Object.prototype || proto === null;
    if (!(v instanceof Map || v instanceof Set || Array.isArray(v) || plain)) {
      return { t: "unsupported", c: ctorName(v) };
    }
    // A value that is its own ancestor cannot be encoded as a tree.
    if (path.has(v)) return { t: "unsupported", c: "Cycle" };
    path.add(v);
    try {
      if (v instanceof Map) {
        const a = [];
        for (const [k, x] of v) a.push([await enc(k, path, meter), await enc(x, path, meter)]);
        return { t: "map", v: a };
      }
      if (v instanceof Set) {
        const a = [];
        for (const x of v) a.push(await enc(x, path, meter));
        return { t: "set", v: a };
      }
      if (Array.isArray(v)) {
        const a = [];
        for (let i = 0; i < v.length; i++) a.push(await enc(v[i], path, meter));
        return { t: "arr", v: a };
      }
      const o = {};
      for (const k of Object.keys(v)) {
        charge(meter, k.length + 3);
        Object.defineProperty(o, k, {
          value: await enc(v[k], path, meter), writable: true, enumerable: true, configurable: true,
        });
      }
      return { t: "obj", v: o };
    } finally {
      path.delete(v);
    }
  }

  // Any native error from malformed input becomes UnsupportedValue, with a
  // fixed text that never carries the input.
  function decode(e) {
    try {
      return decodeTagged(e);
    } catch (err) {
      if (err instanceof UnsupportedValue) throw err;
      throw new UnsupportedValue("malformed encoding");
    }
  }

  function decodeTagged(e) {
    if (e === null || typeof e !== "object") throw new UnsupportedValue("bad encoding");
    switch (e.t) {
      case "undef": return undefined;
      case "j": {
        // C3: null, a boolean, a string or a finite number other than -0. Any
        // other JSON value would skip the typed decoding of every value in it.
        const v = e.v;
        const ok = v === null || typeof v === "boolean" || typeof v === "string" ||
          (typeof v === "number" && Number.isFinite(v) && !Object.is(v, -0));
        if (!ok) throw new UnsupportedValue("bad json value");
        return v;
      }
      case "num":
        if (!["NaN", "Infinity", "-Infinity", "-0"].includes(e.v)) throw new UnsupportedValue("bad number");
        return Number(e.v);
      case "big":
        if (typeof e.v !== "string" || !/^-?[0-9]+$/.test(e.v)) throw new UnsupportedValue("bad bigint");
        return BigInt(e.v);
      case "date": return new Date(e.v === null ? NaN : e.v);
      case "blob": {
        const bytes = fromB64(e.v);
        if (e.name !== undefined) {
          return new File([bytes], e.name, { type: e.type, lastModified: e.lastModified });
        }
        return new Blob([bytes], { type: e.type });
      }
      case "ab": return fromB64(e.v).buffer;
      case "view": {
        if (!VIEWS.includes(e.c) || typeof globalThis[e.c] !== "function") {
          throw new UnsupportedValue("unsupported view");
        }
        const u8 = fromB64(e.v);
        const C = globalThis[e.c];
        if (C === DataView) return new DataView(u8.buffer);
        if (u8.byteLength % C.BYTES_PER_ELEMENT !== 0) throw new UnsupportedValue("bad view length");
        return new C(u8.buffer, 0, u8.byteLength / C.BYTES_PER_ELEMENT);
      }
      case "map": return new Map(e.v.map(([k, x]) => [decode(k), decode(x)]));
      case "set": return new Set(e.v.map(decode));
      case "arr": return e.v.map(decode);
      case "re": return new RegExp(e.s, e.f);
      case "obj": {
        const o = {};
        for (const k of Object.keys(e.v)) {
          Object.defineProperty(o, k, {
            value: decode(e.v[k]), writable: true, enumerable: true, configurable: true,
          });
        }
        return o;
      }
      // c is the sender's text (a class name of the page); no error text repeats it.
      case "unsupported": throw new UnsupportedValue("unsupported value");
      default: throw new UnsupportedValue("unknown tag");
    }
  }

  globalThis.agentwatchCodec = { encode, decode, UnsupportedValue };
})();
