// The units that hold the MCP port (contract C11, "The MCP path"; the self-contained design, section 19, build note 1:
// the daemon lead's proposal, which stage 1d proves). agentwatch's install writes the real units, not agent-browser:
//
// - agent-browser-mcp.socket: ListenStream=127.0.0.1:<port>, Accept=no, Service=agent-browser-mcp-hold.service. It holds
//   the port while the service is down, so another OS user cannot take it; a connection then waits with no answer.
// - agent-browser-mcp-hold.service: Type=oneshot, RemainAfterExit=yes, ExecStart=/bin/true. It never touches Chrome, and
//   no connection ever starts agent-browser.service.
// - agent-browser.service takes the socket's fd through Sockets= (src/service/mcp/listen-fds.ts reads it).
//
// These are the same texts with a test's own names, for the opt-in live test (test/mcp-units-live.test.ts). With a unit
// name other than agent-browser-mcp.socket, the socket sets FileDescriptorName=agent-browser-mcp.socket, so that the
// service finds its fd by the name that the real unit has.

import { MCP_SOCKET_UNIT } from "../../src/service/mcp/listen-fds.ts";

export type UnitNames = { readonly socket: string; readonly hold: string; readonly service: string };

/** A test's unit names: unique by `tag`, never a name of agentwatch's own units. */
export const unitNames = (tag: string): UnitNames => ({ socket: `ab-test-${tag}-mcp.socket`, hold: `ab-test-${tag}-mcp-hold.service`, service: `ab-test-${tag}-service.service` });

/** The three unit files: the socket, its oneshot holder, and the stand-in of agent-browser.service, which takes the fd. */
export function unitTexts(o: { names: UnitNames; port: number; execStart: string }): Record<string, string> {
  return {
    [o.names.socket]: [
      "[Unit]",
      `Description=agent-browser MCP port hold (test ${o.names.socket})`,
      "",
      "[Socket]",
      `ListenStream=127.0.0.1:${o.port}`,
      "Accept=no",
      `Service=${o.names.hold}`,
      `FileDescriptorName=${MCP_SOCKET_UNIT}`,
      "",
    ].join("\n"),
    [o.names.hold]: [
      "[Unit]",
      `Description=agent-browser MCP port holder (test ${o.names.hold}): it never touches Chrome`,
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      "ExecStart=/bin/true",
      "",
    ].join("\n"),
    [o.names.service]: [
      "[Unit]",
      `Description=agent-browser service stand-in (test ${o.names.service}): it takes the MCP port's fd`,
      "",
      "[Service]",
      "Type=simple",
      `Sockets=${o.names.socket}`,
      `ExecStart=${o.execStart}`,
      "",
    ].join("\n"),
  };
}

/**
 * The stand-in's script: it takes the fd by the sd_listen_fds protocol and serves the MCP port on it with the real
 * reader, with one session whose root and fingerprint come from the JSON file next to it (no secret in its argv).
 */
export const STANDIN = `
import { readFileSync } from "node:fs";
const [root, config] = process.argv.slice(2);
const { takeMcpSocket } = await import(root + "/src/service/mcp/listen-fds.ts");
const { McpPort } = await import(root + "/src/service/mcp/port.ts");
const { procReader } = await import(root + "/src/service/mcp/proc.ts");
const c = JSON.parse(readFileSync(config, "utf8"));
const port = await McpPort.open({ listen: { fd: await takeMcpSocket(process.env) }, reader: procReader(), log: (l) => console.error(l),
  readiness: () => ({ controlOff: false, notReady: null, sites: 1 }),
  handler: { request: (req, res, scope) => res.writeHead(200, { "Content-Length": 9 + scope.length }).end("admitted " + scope), endSessions: () => {} } });
port.setSessions({ sessions: [{ scope: c.scope, repo: null, roots: [c.root], cgroup: null, lifetime_id: "lt-test-units", mcp_token: c.fingerprint }] });
process.on("SIGTERM", () => { void port.stop().then(() => process.exit(0)); });
`;
