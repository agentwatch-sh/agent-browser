// The folders and files of the Chrome unit (the self-contained design, sections 5.1, 5.2 and 13.2; board ab-v16.94.3).
// The service takes its state folder (--state-folder) and its tools folder (--tools-dir) from its unit, with no default
// (agentwatch writes the unit at the install). The unit gives today's folders of agentwatch's daemon, so a switch-on
// moves no file and keeps every sent sign-in: its browser state folder (the profile, unit.json, the X auth file) and
// its tools folder (google-chrome/<version>/), both under ~/.local/share/. This file names them only for `--test`,
// which refuses them. Every path is computed from the folders that the service got.

import { homedir } from "node:os";
import { join } from "node:path";

/** Today's state folder of the agent browser (agentwatch's daemon/browser/stop_unit.py, STATE_PARTS): `--test` refuses it. */
export const defaultStateDir = (home = homedir()) => join(home, ".local", "share", "agentwatch-browser");
/** Today's tools folder (agentwatch's tools/install.py, tools_root()): `--test` refuses it. */
export const defaultToolsDir = (home = homedir()) => join(home, ".local", "share", "agentwatch-tools");

export type UnitPaths = {
  state: string;
  tools: string;
  profile: string;
  /** The unit record (today's format; the owner writes it). */
  unitFile: string;
  /** The X auth file of the unit's Xvfb (mode 0600). */
  xauth: string;
  /** Chrome's HOME, so its downloads stay in the state folder. */
  home: string;
  downloads: string;
  preferences: string;
  /** The Chrome update's state: the last good copy, the failed moves, since when an update waits. */
  updateFile: string;
  /** The fail-closed watch's count, kept on disk (the design's build note 5). */
  watchFile: string;
  /** The copies of Google Chrome: <tools>/google-chrome/<version>/. */
  chromes: string;
};

export function unitPaths(state: string, tools: string): UnitPaths {
  const profile = join(state, "profile"), home = join(state, "home");
  return {
    state, tools, profile, home,
    unitFile: join(state, "unit.json"),
    xauth: join(state, "xauth"),
    downloads: join(home, "Downloads"),
    preferences: join(profile, "Default", "Preferences"),
    updateFile: join(state, "chrome-update.json"),
    watchFile: join(state, "watch.json"),
    chromes: join(tools, "google-chrome"),
  };
}
