// review-54's check (board ab-v16.47): a dynamic import inside the self-test lets the relay go on and
// fail closed (the self-test's 503) on a Node without node:ffi (try --no-experimental-ffi).
let ffi = null;
try { ffi = (await import("node:ffi")).default; } catch (e) { console.log("dynamic import failed:", e.code); }
console.log("relay goes on; ffi", ffi ? "present" : "absent: self-test 503");
