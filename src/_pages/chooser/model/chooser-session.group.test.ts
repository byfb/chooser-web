// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import type { ChooserSettings } from "./chooser-settings";
import {
  createChooserSession,
  type ChooserClock,
  type ChooserColor,
  type ChooserEffects,
  type ChooserScheduler,
} from "./chooser-session";

const GROUP_SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  selectionMode: "group",
  selectionCount: 2,
  soundEnabled: true,
  vibrationEnabled: true,
  topPaddingPx: 0,
  circleSizePercent: 100,
  singleDelayMs: 3000,
  groupDelayMs: 3000,
  orderDelayMs: 3000,
  singleLifetimeMs: 1000,
  groupLifetimeMs: 1000,
  orderLifetimeMs: 1500,
});

const WHITE: ChooserColor = Object.freeze({ r: 255, g: 255, b: 255 });
const BLACK: ChooserColor = Object.freeze({ r: 0, g: 0, b: 0 });
const RGB_QUANTIZATION_TOLERANCE = 0.02;

describe("Group selection public contract", () => {
  it("starts a default Group participant with a white color before settlement", () => {
    const random = createCountingRandom(0.25);
    const { session } = setup({
      random,
    });

    session.send(directDown(1, 10, 20, { color: { r: 12, g: 34, b: 56 } }));

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      result: null,
      participants: [
        {
          id: "direct:1",
          color: WHITE,
          state: "active",
        },
      ],
    });
    expect(random.calls()).toBe(0);
  });

  it("keeps collecting when participant count equals Group count, then settles after the next addition", () => {
    const { scheduler, session } = setup({
      settings: { ...GROUP_SETTINGS, groupDelayMs: 1 },
    });

    session.send(directDown(1, 10, 10, { color: { r: 1, g: 2, b: 3 } }));
    session.send(directDown(2, 20, 20, { color: { r: 4, g: 5, b: 6 } }));

    const ineligibleAttempt = scheduler.latestTimeout();
    scheduler.run(ineligibleAttempt);

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      activeParticipantCount: 2,
      result: null,
    });

    session.send(directDown(3, 30, 30, { color: { r: 7, g: 8, b: 9 } }));
    const eligibleAttempt = scheduler.latestTimeout();
    expect(eligibleAttempt).not.toBe(ineligibleAttempt);
    scheduler.run(eligibleAttempt);

    expect(session.getSnapshot().phase).toBe("result");
    expect(groupResult(session.getSnapshot()).groups).toHaveLength(2);
  });

  it("assigns five participants exactly once into balanced, ordered Group results", () => {
    const { scheduler, session } = setup({
      settings: { ...GROUP_SETTINGS, groupDelayMs: 1 },
    });
    addDirectParticipants(session, 5);
    scheduler.run(scheduler.latestTimeout());

    const snapshot = session.getSnapshot();
    const result = groupResult(snapshot);

    expect(snapshot).toMatchObject({
      phase: "result",
      controlsVisible: false,
      activeParticipantCount: 0,
      background: BLACK,
    });
    expect(result.background).toEqual(BLACK);
    expect(result.groups.map((group) => group.groupId)).toEqual([0, 1]);
    expect(result.groups.map((group) => group.participantIds.length)).toEqual([
      3, 2,
    ]);
    expect(
      new Set(result.groups.map((group) => colorKey(group.color))).size,
    ).toBe(2);

    const assignedIds = result.groups.flatMap((group) => group.participantIds);
    expect(assignedIds).toHaveLength(5);
    expect(new Set(assignedIds).size).toBe(5);
    expect([...assignedIds].sort(compareParticipantIds)).toEqual([
      "direct:1",
      "direct:2",
      "direct:3",
      "direct:4",
      "direct:5",
    ]);

    const groupedParticipants =
      snapshot.participants as unknown as readonly GroupedParticipantContract[];
    expect(groupedParticipants).toHaveLength(5);
    groupedParticipants.forEach((participant) => {
      const participantGroup = result.groups.find(
        (group) => group.groupId === participant.groupId,
      );
      expect(participant.state).toBe("grouped");
      expect(participant.groupId).toBeGreaterThanOrEqual(0);
      expect(participant.groupId).toBeLessThan(2);
      expect(participantGroup).toBeDefined();
      expect(participantGroup?.participantIds).toContain(participant.id);
      expect(participant.targetColor).toEqual(participantGroup?.color);
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.groups)).toBe(true);
    result.groups.forEach((group) => {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.participantIds)).toBe(true);
      expect(Object.isFrozen(group.color)).toBe(true);
    });
  });

  it("keeps a Group result after direct terminal events, stays silent, and vibrates once", () => {
    const effects = new FakeEffects();
    const { scheduler, session } = setup({ effects });
    settleGroup(session, scheduler, 3);

    const settled = groupResult(session.getSnapshot());
    session.send({ type: "pointer-up", pointerId: 1 });
    session.send({ type: "pointer-cancel", pointerId: 2 });
    session.send({ type: "lost-pointer-capture", pointerId: 3 });

    expect(session.getSnapshot().phase).toBe("result");
    expect(groupResult(session.getSnapshot())).toEqual(settled);
    expect(effects.sounds).toEqual(["down", "down", "down"]);
    expect(effects.sounds).not.toContain("chosen");
    expect(effects.vibrations).toEqual([100]);
  });

  it("preserves the Group result when vibration is disabled", () => {
    const effects = new FakeEffects();
    const { scheduler, session } = setup({
      effects,
      settings: { ...GROUP_SETTINGS, vibrationEnabled: false },
    });
    settleGroup(session, scheduler, 3);

    expect(session.getSnapshot().phase).toBe("result");
    expect(effects.sounds).toEqual(["down", "down", "down"]);
    expect(effects.vibrations).toEqual([]);
    expect(groupResult(session.getSnapshot()).groups).toHaveLength(2);
  });

  it("preserves the Group result when feedback effects throw", () => {
    const effects = new ThrowingEffects();
    const { scheduler, session } = setup({ effects });
    settleGroup(session, scheduler, 3);

    const snapshot = session.getSnapshot();
    expect(snapshot.phase).toBe("result");
    expect(groupResult(snapshot).groups).toHaveLength(2);
    expect(effects.sounds).toEqual(["down", "down", "down"]);
    expect(effects.vibrations).toEqual([100]);
  });

  it("generates distinct Group colors with evenly spaced hues and bounded saturation/value", () => {
    const random = createSequenceRandom([
      0.137, 0.81, 0.62, 0.96, 0.74, 0.53, 0.87, 0.69, 0.58,
      // These values drive non-identity palette swaps while staying valid if
      // an implementation consumes the sequence in a nearby order.
      0.6, 0.55, 0.7, 0.92, 0.64, 0.84, 0.76,
    ]);
    const { scheduler, session } = setup({
      random,
      settings: { ...GROUP_SETTINGS, groupDelayMs: 1, selectionCount: 4 },
    });
    addDirectParticipants(session, 6);
    scheduler.run(scheduler.latestTimeout());

    const result = groupResult(session.getSnapshot());
    expect(result.groups).toHaveLength(4);
    expect(
      new Set(result.groups.map((group) => colorKey(group.color))).size,
    ).toBe(4);

    const hues = result.groups.map((group) => rgbToHsv(group.color).hue);
    const sortedHues = [...hues].sort((left, right) => left - right);
    expect(hues).not.toEqual(sortedHues);
    const expectedGap = 360 / result.groups.length;
    const gaps = sortedHues.map((hue, index) => {
      const nextHue = sortedHues[(index + 1) % sortedHues.length] ?? hue;
      return (nextHue - hue + 360) % 360;
    });
    gaps.forEach((gap) => {
      expect(Math.abs(gap - expectedGap)).toBeLessThanOrEqual(8);
    });

    result.groups.forEach((group) => {
      const { saturation, value } = rgbToHsv(group.color);
      expect(saturation).toBeGreaterThanOrEqual(
        0.5 - RGB_QUANTIZATION_TOLERANCE,
      );
      expect(saturation).toBeLessThanOrEqual(1 + RGB_QUANTIZATION_TOLERANCE);
      expect(value).toBeGreaterThanOrEqual(0.5 - RGB_QUANTIZATION_TOLERANCE);
      expect(value).toBeLessThanOrEqual(1 + RGB_QUANTIZATION_TOLERANCE);
    });
  });

  it(
    "keeps all 20 first-group subsets reachable across 100,000 fixed-seed samples",
    { timeout: 30_000 },
    () => {
      const outcomeKeys = combinations(
        [
          "direct:1",
          "direct:2",
          "direct:3",
          "direct:4",
          "direct:5",
          "direct:6",
        ],
        3,
      ).map((ids) => ids.join("|"));
      const counts = sampleGroupFirstGroupOutcomes({
        participantCount: 6,
        sampleCount: 100_000,
        seed: 0x9e3779b9,
        outcomeKeys,
      });

      expectChiSquareBelow(counts, 100_000, 43.820196);
    },
  );
});

interface GroupResultContract {
  readonly kind: "group";
  readonly groups: readonly {
    readonly groupId: number;
    readonly participantIds: readonly string[];
    readonly color: ChooserColor;
  }[];
  readonly background: ChooserColor;
}

interface GroupedParticipantContract {
  readonly id: string;
  readonly state: "grouped";
  readonly groupId: number;
  readonly targetColor: ChooserColor;
}

interface SetupOverrides {
  readonly effects?: ChooserEffects;
  readonly random?: { next(): number };
  readonly scheduler?: FakeScheduler;
  readonly settings?: Readonly<ChooserSettings>;
}

function setup(overrides: SetupOverrides = {}) {
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  const effects = overrides.effects ?? new FakeEffects();
  let now = 100;
  const clock: ChooserClock = {
    now: () => now++,
  };
  const session = createChooserSession({
    clock,
    effects,
    random: overrides.random ?? { next: () => 0.25 },
    scheduler,
    settings: overrides.settings ?? GROUP_SETTINGS,
  });
  return { effects, scheduler, session };
}

function directDown(
  pointerId: number,
  x: number,
  y: number,
  overrides: { readonly color?: Readonly<ChooserColor> } = {},
) {
  return {
    type: "pointer-down" as const,
    button: 0,
    isPrimary: true,
    pointerId,
    pointerType: "touch" as const,
    position: { x, y },
    color: overrides.color,
  };
}

function addDirectParticipants(
  session: ReturnType<typeof createChooserSession>,
  count: number,
) {
  for (let pointerId = 1; pointerId <= count; pointerId += 1) {
    session.send(
      directDown(pointerId, pointerId * 10, pointerId * 10, {
        color: {
          r: pointerId,
          g: pointerId + 1,
          b: pointerId + 2,
        },
      }),
    );
  }
}

function settleGroup(
  session: ReturnType<typeof createChooserSession>,
  scheduler: FakeScheduler,
  participantCount: number,
) {
  addDirectParticipants(session, participantCount);
  scheduler.run(scheduler.latestTimeout());
}

function groupResult(
  snapshot: ReturnType<
    typeof createChooserSession
  >["getSnapshot"] extends () => infer T
    ? T
    : never,
) {
  const result = snapshot.result as unknown as GroupResultContract | null;
  if (result?.kind !== "group") {
    throw new Error(
      `Expected a Group result, received ${result?.kind ?? "none"}`,
    );
  }
  return result;
}

function colorKey(color: Readonly<ChooserColor>) {
  return `${color.r},${color.g},${color.b}`;
}

function compareParticipantIds(left: string, right: string) {
  return Number(left.split(":")[1]) - Number(right.split(":")[1]);
}

function createSequenceRandom(values: readonly number[]) {
  let index = 0;
  return {
    next() {
      const value = values[index % values.length];
      index += 1;
      return value ?? 0;
    },
  };
}

function createCountingRandom(value: number) {
  let count = 0;
  return {
    calls: () => count,
    next() {
      count += 1;
      return value;
    },
  };
}

function createXorshift32(seed: number) {
  let state = seed >>> 0;
  return {
    next() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    },
  };
}

function sampleGroupFirstGroupOutcomes(options: {
  readonly participantCount: number;
  readonly sampleCount: number;
  readonly seed: number;
  readonly outcomeKeys: readonly string[];
}) {
  const counts = new Map<string, number>(
    options.outcomeKeys.map((key) => [key, 0]),
  );
  const random = createXorshift32(options.seed);
  const effects: ChooserEffects = {
    playSound: () => undefined,
    vibrate: () => undefined,
  };
  const clock: ChooserClock = { now: () => 0 };

  for (let sample = 0; sample < options.sampleCount; sample += 1) {
    const scheduler = new FakeScheduler();
    const session = createChooserSession({
      clock,
      effects,
      random,
      scheduler,
      settings: {
        ...GROUP_SETTINGS,
        groupDelayMs: 1,
        soundEnabled: false,
        vibrationEnabled: false,
      },
    });

    addDirectParticipants(session, options.participantCount);
    scheduler.run(scheduler.latestTimeout());

    const groups = groupResult(session.getSnapshot()).groups;
    const firstGroup = groups.find((group) => group.groupId === 0);
    if (firstGroup === undefined) {
      throw new Error("Group result did not include group 0");
    }
    const key = [...firstGroup.participantIds]
      .sort(compareParticipantIds)
      .join("|");
    const previousCount = counts.get(key);
    if (previousCount === undefined) {
      throw new Error(`Unexpected Group outcome: ${key}`);
    }
    counts.set(key, previousCount + 1);
    session.destroy();
  }

  return counts;
}

function expectChiSquareBelow(
  counts: ReadonlyMap<string, number>,
  sampleCount: number,
  criticalValue: number,
) {
  const expected = sampleCount / counts.size;
  expect(expected).toBeGreaterThan(5);
  counts.forEach((count) => expect(count).toBeGreaterThan(0));

  const statistic = [...counts.values()].reduce((sum, observed) => {
    const difference = observed - expected;
    return sum + (difference * difference) / expected;
  }, 0);
  expect(statistic).toBeLessThan(criticalValue);
}

function combinations<T>(values: readonly T[], count: number): T[][] {
  if (count === 0) {
    return [[]];
  }

  return values.flatMap((value, index) =>
    combinations(values.slice(index + 1), count - 1).map((rest) => [
      value,
      ...rest,
    ]),
  );
}

function rgbToHsv(color: Readonly<ChooserColor>) {
  const red = color.r / 255;
  const green = color.g / 255;
  const blue = color.b / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;
  const saturation = maximum === 0 ? 0 : difference / maximum;
  let hue = 0;

  if (difference !== 0) {
    if (maximum === red) {
      hue = 60 * (((green - blue) / difference) % 6);
    } else if (maximum === green) {
      hue = 60 * ((blue - red) / difference + 2);
    } else {
      hue = 60 * ((red - green) / difference + 4);
    }
  }

  return {
    hue: (hue + 360) % 360,
    saturation,
    value: maximum,
  };
}

interface FakeTask {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly kind: "frame" | "timeout";
  cancelled: boolean;
}

class FakeScheduler implements ChooserScheduler {
  readonly tasks: FakeTask[] = [];

  cancelAnimationFrame(handle: unknown) {
    this.cancel(handle);
  }

  clearTimeout(handle: unknown) {
    this.cancel(handle);
  }

  requestAnimationFrame(callback: () => void) {
    return this.schedule("frame", callback, 0);
  }

  setTimeout(callback: () => void, delayMs: number) {
    return this.schedule("timeout", callback, delayMs);
  }

  latestTimeout() {
    const task = this.tasks.findLast(
      (candidate) => candidate.kind === "timeout",
    );
    if (task === undefined) {
      throw new Error("No timeout was scheduled");
    }
    return task;
  }

  run(task: FakeTask) {
    task.callback();
  }

  private cancel(handle: unknown) {
    (handle as FakeTask).cancelled = true;
  }

  private schedule(
    kind: FakeTask["kind"],
    callback: () => void,
    delayMs: number,
  ) {
    const task: FakeTask = { callback, cancelled: false, delayMs, kind };
    this.tasks.push(task);
    return task;
  }
}

class FakeEffects implements ChooserEffects {
  readonly sounds: Array<"chosen" | "down" | "up"> = [];
  readonly vibrations: number[] = [];

  playSound(cue: "chosen" | "down" | "up") {
    this.sounds.push(cue);
  }

  vibrate(durationMs: 40 | 100) {
    this.vibrations.push(durationMs);
  }
}

class ThrowingEffects extends FakeEffects {
  override playSound(cue: "chosen" | "down" | "up") {
    super.playSound(cue);
    throw new Error("sound failure");
  }

  override vibrate(durationMs: 40 | 100) {
    super.vibrate(durationMs);
    throw new Error("vibration failure");
  }
}
