// Loads this package's TypeScript without a build step.
//
// Node 26 strips TypeScript types itself, except for files under node_modules, where it refuses
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). A consumer that pins this repo as a git dependency
// gets it in node_modules, so there this file registers one load hook that strips the types of this
// package's own src/*.ts files, and of nothing else. From a checkout, Node strips them natively and
// no hook is registered.

import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("./src/", import.meta.url).href;
let hooked = false;

const underNodeModules = (url) => fileURLToPath(url).split(/[\\/]/).includes("node_modules");

/** stripTypeScriptTypes warns once per process that it is experimental; that one warning is dropped, and no other. */
function quietly(fn) {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/stripTypeScriptTypes/.test(String(text))) return;
    return emit.call(this, warning, ...rest);
  };
  try { return fn(); } finally { process.emitWarning = emit; }
}

function hook() {
  if (hooked) return;
  hooked = true;
  quietly(() => stripTypeScriptTypes(""));
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(SRC) && new URL(url).pathname.endsWith(".ts")) {
        const source = stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip", sourceUrl: url });
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

/** import() a module of this package, given relative to the package root (for example "./src/index.ts"). */
export function importSource(specifier) {
  const url = new URL(specifier, import.meta.url).href;
  if (underNodeModules(url)) hook();
  return import(url);
}
