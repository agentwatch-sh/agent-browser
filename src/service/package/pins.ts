// The agent package of `agent-browser service` (stage 1b part 2 of the self-contained agent browser, board ab-v16.94.9;
// the design, sections 5.1 "The agent package" and 6; chrome-extension docs/protocol.md, C1): agent-browser, not
// agentwatch, pins the chrome-extension commit, the receiver ID and the CRX's SHA-256. The pinned commit's files ship
// in this folder, so the service needs no checkout of chrome-extension and no download:
//
// - chrome-extension/agent.crx: the commit's release/agent.crx, the packed agent/ folder (the receiver), signed with
//   the receiver's key. The service never holds that key: it checks the CRX against AGENT_CRX_SHA256 and the ID.
// - chrome-extension/operator/: the commit's operator/ folder (the sender); the service zips it for C12's `sender`.
//
// A test ties each file to the pinned commit: the CRX by its SHA-256, each file of operator/ by its git blob id.

import { fileURLToPath } from "node:url";

/** The release commit of chrome-extension: receiver 0.3.6 (agentwatch's pin today; chrome-extension main reaches it). */
export const CHROME_EXTENSION_COMMIT = "7e2d9a4a5d9bfcdacee4ea219101f2bed79053ab";
/** The receiver's extension ID (C1): the key that signs agent.crx fixes it. */
export const RECEIVER_ID = "ifhfjdmdbgbnmllffiadajepajbcdnai";
/** The sender's extension ID (C1): the `key` of operator/manifest.json fixes it. */
export const SENDER_ID = "bpfkgknpndlpkcffmaaelkfcbpackiip";
/** The native messaging host name (C1): the receiver connects to it, so it stays. */
export const NATIVE_HOST_NAME = "sh.agentwatch.browser";
/** The SHA-256 of the commit's release/agent.crx (`git show <commit>:release/agent.crx | sha256sum`). */
export const AGENT_CRX_SHA256 = "84525f44f290441d42606415f8086a9855ea0eb463bcd696a160f42c325a579a";
/** The receiver's version in the pinned CRX (its manifest's `version`). */
export const AGENT_VERSION = "0.3.6";

/** The pinned CRX, as it ships with agent-browser. */
export const AGENT_CRX = fileURLToPath(new URL("./chrome-extension/agent.crx", import.meta.url));
/** The pinned operator/ folder (the sender), as it ships with agent-browser. */
export const OPERATOR_DIR = fileURLToPath(new URL("./chrome-extension/operator/", import.meta.url));

/** The git blob id of each file of operator/ at the pinned commit (`git ls-tree -r <commit> -- operator`). */
export const OPERATOR_BLOBS: Readonly<Record<string, string>> = Object.freeze({
  "icons/icon-128.png": "35a8fbde4c35431f1ffe9e0519d740bd0fed302d",
  "icons/icon-16.png": "41044c0b8a102a28827fe60bf53fbe40d0349d36",
  "icons/icon-32.png": "af481ebefdd6b9a5fad4f27aac9be1966addb858",
  "icons/icon-48.png": "25b3601e3706bdd57f6566c192d87efa3bab43c7",
  "lib/.keep": "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "lib/codec.js": "e4d153a8adbdac5475dff267cc0d2048ad1d5066",
  "lib/cookies.js": "4de72e74a4f18c461a6de45323cfe89d8e7aea04",
  "lib/domains.js": "5b5d807dc42c971f1eaecb340f16501294c96691",
  "manifest.json": "dacdf6624575ca5654e604db2d694488258aedf3",
  "options.html": "c80acb0a9bf4be9f92e60bc67ee4ad5fd6092d91",
  "options.js": "2f79ac282710bcbae43d95db36c98201ff0e6b2d",
  "popup.css": "3e00112d9b314c1650d4fe97e0263c44f37b2d75",
  "popup.html": "3561c99647114fc9622d2a7d84986da8ba4482b9",
  "popup.js": "7bff0ca9257485968670da2d2fbce61570f1027a",
  "read-page.js": "e6c5bd5cd373016b51bc25c833c3d22137e697ec",
  "send.js": "2445265efc463f58f8856e5e1da02a32ce3c003b",
  "sw.js": "b5c72bb6cbe2d684b22efc5bc78f74136a7659fe",
});
