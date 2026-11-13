// `agent-browser sign-in <name>` and `agent-browser sign-ins` (contract C11, the sign-in act; board ab-v16.97.4): the
// CLI's way to the stored sign-ins. Each sends its method, AgentBrowser.signIn or AgentBrowser.signIns, on the root
// session of agent mode's endpoint (--cdp-url, the agent door of the service), so the walk gives the scope: the CLI
// names only the credential, never a scope, a repo, a username or a password. The answer holds no value: on success the
// name, the origin and C11's text; on a refusal C11's text, and the exit status 1.

import { CDPConnection, CDPError } from "./cdp.ts";
import { AgentBrowserError, UsageError } from "./errors.ts";
import type { Settings } from "./options.ts";
import { signedInText } from "./service/signins/act-rules.ts";

/** The longest act (check 7's 60 s, the page's load and the outcome's 30 s each, the receiver's waits) and a margin. */
export const SIGN_IN_WAIT_MS = 240_000;

export type SignInResult = { ok: true; command: "sign-in"; signedIn: true; name: string; origin: string; text: string };
export type SignInsResult = { ok: true; command: "sign-ins"; state: "none" | "locked" | "open"; signIns: { name: string; origin: string }[] };

/** One method on the endpoint's root session; a CDP error becomes its own text (C11's `Not signed in: <text>`), exit 1. */
async function send(s: Settings, method: string, params: object): Promise<any> {
  if (!s.cdpUrl) throw new UsageError("sign-in and sign-ins need agent mode's endpoint (--cdp-url): the stored sign-ins are the agent browser service's");
  const conn = await CDPConnection.connect(s.cdpUrl, 10_000).catch((e) => { throw new AgentBrowserError("error", `could not reach the agent browser: ${(e as Error).message}`); });
  try { return await conn.send(method, params, undefined, SIGN_IN_WAIT_MS); }
  catch (e) {
    if (e instanceof CDPError && e.message.startsWith(`${method}: `)) throw new AgentBrowserError("error", e.message.slice(method.length + 2));
    throw e;
  } finally { await conn.close(); }
}

/** `sign-in <name>`: AgentBrowser.signIn with the name. */
export async function signIn(s: Settings, name: string): Promise<SignInResult> {
  const r = await send(s, "AgentBrowser.signIn", { name });
  if (r?.signedIn !== true || typeof r.origin !== "string" || typeof r.name !== "string") throw new AgentBrowserError("error", "the agent browser gave no answer of a sign-in");
  return { ok: true, command: "sign-in", signedIn: true, name: r.name, origin: r.origin, text: signedInText(r.origin) };
}

/** `sign-ins`: AgentBrowser.signIns: the store's state and the names and origins that this session's scope may use. */
export async function signIns(s: Settings): Promise<SignInsResult> {
  const r = await send(s, "AgentBrowser.signIns", {});
  const list = Array.isArray(r?.signIns) ? r.signIns.filter((x: any) => typeof x?.name === "string" && typeof x?.origin === "string").map((x: any) => ({ name: x.name, origin: x.origin })) : [];
  return { ok: true, command: "sign-ins", state: r?.state === "open" || r?.state === "locked" ? r.state : "none", signIns: list };
}

/** The human form of either result. */
export function signInHuman(r: SignInResult | SignInsResult): string {
  if (r.command === "sign-in") return `${r.text}\n`;
  return [`stored sign-ins: ${r.state}`, ...r.signIns.map((x) => `${x.name.padEnd(24)} ${x.origin}`)].join("\n") + "\n";
}
