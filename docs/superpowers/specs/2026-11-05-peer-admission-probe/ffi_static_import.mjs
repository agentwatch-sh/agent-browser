// review-54's check (board ab-v16.47): a static import of node:ffi prints the ExperimentalWarning at
// load, and fails at load on a Node without it (try --no-experimental-ffi): ERR_UNKNOWN_BUILTIN_MODULE.
import ffi from "node:ffi";
console.log("loaded", typeof ffi.dlopen);
