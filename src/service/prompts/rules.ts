// The warnings of a blocked-site prompt (stage 1c, board ab-v16.94.4): the port of agentwatch's
// browser_prompt_rules.py. An exact broad provider covers every customer of the provider and its own site; a shared
// sign-in host serves every account of the provider. The list names no provider type: a warning only tells the
// operator what an allow of the host gives.

import { covers } from "../lists/hosts.ts";

export const BROAD_HOSTS: ReadonlySet<string> = new Set(["auth0.com", "okta.com", "google.com", "microsoftonline.com"]);
/** agentwatch's list: agent-browser's own SIGN_IN_HOSTS (src/errors.ts) and github.com. */
export const SIGN_IN_HOSTS: readonly string[] = [
  "accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "signin.aws.amazon.com", "id.atlassian.com", "github.com",
];
export const BROAD_TEXT = "This covers every customer of the provider and its own site. Use your tenant's host.";
export const SHARED_TEXT = "This host serves every account of the provider. With it, an agent's script on this list's sites can use every page of it with your sign-in there, for example your account's settings.";

export type Warning = { kind: "broad" | "shared"; text: string };

/** The warnings of an allow of `host`: `broad` for an exact broad provider, `shared` for a sign-in host or its subdomain. */
export function warningsFor(host: string): Warning[] {
  const out: Warning[] = [];
  if (BROAD_HOSTS.has(host)) out.push({ kind: "broad", text: BROAD_TEXT });
  if (SIGN_IN_HOSTS.some((p) => covers(p, host))) out.push({ kind: "shared", text: SHARED_TEXT });
  return out;
}
