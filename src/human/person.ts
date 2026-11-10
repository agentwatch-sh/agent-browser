// One simulated person (board ab-t30.3; the input design, sections 10.1, 10.3 and 10.4): the parameter file of a
// platform (src/human/params/linux.json, mac.json: each distribution with its bounds and its source), and the draw of one
// person for a scope. If every agent moved with one fixed rhythm, a site could link its sessions by it; so each scope gets
// one person, drawn once from the population's spread, seeded by the scope's name and a seed that its owner keeps for
// the scope's life. Within the scope the person's values stay, with the per-event spread of the parameter file. Part B
// (board ab-t30.7) sets the population's centre and spread; a later fit writes a new file, not a new model.

import { readFileSync } from "node:fs";
import { draw, seededRandom, seedOf, type Dist, type Random } from "./random.ts";

export type Params = {
  format: 1;
  platform: string;
  device: { rateMs: number; latencyMs: [number, number]; wholePx: boolean; wholeMsTimestamps: boolean; maxPxPerMs: number; movesInFlight: number };
  path: {
    fitts: { aMs: number; bMs: number; minMs: number; maxMs: number; spread: Dist };
    arc: { deviation: Dist };
    corrections: { counts: number[]; lastShare: number; errorShare: Dist; lateralShare: number };
    overshoot: { minPx: number; share: number; past: Dist; backShare: Dist; backMinMs: number; maxMs: number };
    jitter: { px: Dist; hz: Dist; fadeShare: number };
    approach: { smallPx: number; warpSmall: Dist; warpLarge: Dist };
    start: { middle: [number, number] };
  };
  press: { pauseMs: Dist; holdMs: Dist; force: number; doubleGapMs: Dist; spread: { sdShare: number; maxShare: number } };
  wheel: { notchPx: number; gapMs: Dist };
  /** The keys (board ab-t30.4; design 10.2): src/human/keys.ts. */
  keys: {
    holdMs: Dist; baseMs: Dist; pairMs: { twoHands: number; sameHand: number; sameFinger: number; sameKey: number };
    pauseMs: { space: Dist; mark: Dist; line: Dist }; drift: { min: number; max: number; keep: number; sd: number };
    shift: { beforeMs: Dist; afterMs: Dist; otherHandShare: number }; chord: { beforeMs: Dist; releaseGapMs: Dist };
    afterReleaseMs: Dist; fastMs: Dist; runSlowMs: number; typeMaxMs: number;
  };
  population: { speed: Dist; pause: Dist; hold: Dist; overshootShare: Dist; side: Dist; keySpeed: Dist };
};

/** One person: the platform's parameters and the values drawn once for the scope. */
export type Person = {
  params: Params;
  /** A factor on Fitts's time (a slower or a faster hand). */
  speed: number;
  /** Factors on the medians of the pause before a press and of the press's hold (their bounds stay). */
  pause: number;
  hold: number;
  /** The share of moves over overshoot.minPx that overshoot. */
  overshootShare: number;
  /** The chance that a path's arc bends to the left of its direction. */
  side: number;
  /** The hand's tremor across the path: its amplitude (px) and frequency (Hz). */
  tremorPx: number;
  tremorHz: number;
  /** A factor on the time from one key press to the next (board ab-t30.4: a slower or a faster typist). */
  keySpeed: number;
};

const files = new Map<string, Params>();

/** The parameter file of a platform ("darwin": mac.json; every other: linux.json), read once. */
export function paramsFor(platform: string = process.platform): Params {
  const name = platform === "darwin" ? "mac" : "linux";
  let p = files.get(name);
  if (!p) {
    p = JSON.parse(readFileSync(new URL(`./params/${name}.json`, import.meta.url), "utf8")) as Params;
    if (p.format !== 1) throw new Error(`src/human/params/${name}.json: format ${p.format} is not 1`);
    files.set(name, p);
  }
  return p;
}

/** Draw one person from the population's spread. */
export function drawPerson(params: Params, random: Random): Person {
  const pop = params.population;
  return {
    params,
    speed: draw(random, pop.speed),
    pause: draw(random, pop.pause),
    hold: draw(random, pop.hold),
    overshootShare: draw(random, pop.overshootShare),
    side: draw(random, pop.side),
    tremorPx: draw(random, params.path.jitter.px),
    tremorHz: draw(random, params.path.jitter.hz),
    // Drawn after the pointer's values, so that a scope's pointer stays the person that it was before the keys (board ab-t30.4).
    keySpeed: draw(random, pop.keySpeed),
  };
}

/** The person of a scope: the same scope name and seed give the same person, other ones another. */
export function personFor(scope: string, seed: number, params: Params = paramsFor()): Person {
  return drawPerson(params, seededRandom(seedOf("person", scope, seed)));
}

/** The population's middle person (each factor 1, the middle of each range): for a test that needs no spread. */
export function middlePerson(params: Params = paramsFor()): Person {
  const mid = (d: Dist) => ("uniform" in d ? (d.uniform[0] + d.uniform[1]) / 2 : "normal" in d ? d.normal[0] : d.lognormal[0]);
  const pop = params.population;
  return { params, speed: mid(pop.speed), pause: mid(pop.pause), hold: mid(pop.hold), overshootShare: params.path.overshoot.share, side: mid(pop.side),
    tremorPx: mid(params.path.jitter.px), tremorHz: mid(params.path.jitter.hz), keySpeed: mid(pop.keySpeed) };
}
