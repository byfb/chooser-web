// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import type { ChooserSettings } from "./chooser-settings";
import {
  createChooserSession,
  type ChooserClock,
  type ChooserColor,
  type ChooserEffects,
  type ChooserSnapshot,
  type ChooserScheduler,
} from "./chooser-session";

const SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  selectionMode: "single",
  selectionCount: 1,
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

describe("createChooserSession participant collection", () => {
  it("starts idle and accepts settings synchronization only while idle", () => {
    const { session } = setup();
    const listener = vi.fn();
    session.subscribe(listener);

    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      selectionMode: "single",
      selectionCount: 1,
      controlsVisible: true,
      inputFamily: null,
      activeParticipantCount: 0,
      participants: [],
      result: null,
      background: { r: 0, g: 0, b: 0 },
    });

    session.send({
      type: "settings-changed",
      settings: { ...SETTINGS, selectionMode: "group", selectionCount: 2 },
    });

    expect(session.getSnapshot()).toMatchObject({
      selectionMode: "group",
      selectionCount: 2,
    });
    expect(listener).toHaveBeenCalledOnce();

    session.send(directDown(7, 10, 20));
    session.send({
      type: "settings-changed",
      settings: { ...SETTINGS, selectionMode: "order", selectionCount: 1 },
    });

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      selectionMode: "group",
      selectionCount: 2,
    });
  });

  it("locks a round to direct input, accepts non-primary contacts, and follows movement", () => {
    const { effects, scheduler, session } = setup();

    session.send(
      directDown(3, 20, 30, {
        color: { r: 12, g: 34, b: 56 },
        isPrimary: false,
      }),
    );

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      controlsVisible: false,
      inputFamily: "direct",
      activeParticipantCount: 1,
      participants: [
        {
          id: "direct:3",
          pointerId: 3,
          inputFamily: "direct",
          position: { x: 20, y: 30 },
          color: { r: 12, g: 34, b: 56 },
          state: "active",
        },
      ],
    });
    expect(effects.sounds).toEqual(["down"]);
    expect(scheduler.activeTimeouts()).toHaveLength(1);

    session.send(mouseDown(1, 200, 200));
    session.send({ type: "pointer-up", pointerId: 1 });
    session.send(
      directDown(4, 40, 50, { isPrimary: false, pointerType: "pen" }),
    );
    expect(session.getSnapshot().activeParticipantCount).toBe(2);

    const scheduledBeforeMove = scheduler.scheduledTaskCount();
    session.send({
      type: "pointer-move",
      pointerId: 3,
      position: { x: 25, y: 35 },
    });

    expect(session.getSnapshot().participants[0]?.position).toEqual({
      x: 25,
      y: 35,
    });
    expect(scheduler.scheduledTaskCount()).toBe(scheduledBeforeMove);
  });

  it("uses one idempotent terminal path and keeps cancellation silent", () => {
    const { effects, scheduler, session } = setup();
    session.send(directDown(3, 20, 30));
    session.send(directDown(4, 40, 50));
    const scheduledBeforeRemoval = scheduler.scheduledTaskCount();

    session.send({ type: "pointer-up", pointerId: 3 });
    session.send({ type: "lost-pointer-capture", pointerId: 3 });
    session.send({ type: "pointer-cancel", pointerId: 3 });

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      activeParticipantCount: 1,
    });
    expect(effects.sounds).toEqual(["down", "down", "up"]);
    expect(scheduler.scheduledTaskCount()).toBe(scheduledBeforeRemoval);

    session.send({ type: "pointer-cancel", pointerId: 4 });
    session.send({ type: "pointer-up", pointerId: 4 });

    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      controlsVisible: true,
      inputFamily: null,
      activeParticipantCount: 0,
    });
    expect(effects.sounds).toEqual(["down", "down", "up"]);
    expect(scheduler.activeTimeouts()).toHaveLength(0);
  });

  it("restarts the full delay only for additions and defers zero delay by one frame", () => {
    const scheduler = new FakeScheduler();
    const { session } = setup({ scheduler });
    session.send(directDown(1, 10, 10));
    const first = scheduler.latestTimeout();

    expect(first.delayMs).toBe(3000);

    session.send({
      type: "pointer-move",
      pointerId: 1,
      position: { x: 20, y: 20 },
    });
    expect(scheduler.latestTimeout()).toBe(first);

    session.send(directDown(2, 30, 30));
    const second = scheduler.latestTimeout();
    expect(second).not.toBe(first);
    expect(first.cancelled).toBe(true);
    expect(second.delayMs).toBe(3000);

    session.send({ type: "pointer-up", pointerId: 1 });
    expect(scheduler.latestTimeout()).toBe(second);

    const beforeStaleCallback = session.getSnapshot();
    scheduler.run(first);
    expect(session.getSnapshot()).toBe(beforeStaleCallback);

    session.send({ type: "pointer-cancel", pointerId: 2 });
    expect(second.cancelled).toBe(true);
    scheduler.run(second);
    expect(session.getSnapshot().phase).toBe("idle");

    session.send({
      type: "settings-changed",
      settings: { ...SETTINGS, singleDelayMs: 0 },
    });
    session.send(directDown(3, 40, 40));
    expect(scheduler.activeFrames()).toHaveLength(1);
    expect(scheduler.activeTimeouts()).toHaveLength(0);
  });

  it("adds persistent simulated participants only after an un-dragged primary mouse activation", () => {
    const { effects, session } = setup();

    session.send(mouseDown(1, 100, 100, 1));
    session.send({ type: "pointer-up", pointerId: 1 });
    expect(session.getSnapshot().participants).toEqual([]);

    session.send(mouseDown(1, 100, 100));
    expect(session.getSnapshot().participants).toEqual([]);
    session.send({
      type: "pointer-move",
      pointerId: 1,
      position: { x: 120, y: 100 },
    });
    session.send({ type: "pointer-up", pointerId: 1 });
    expect(session.getSnapshot().participants).toEqual([]);

    session.send(mouseDown(1, 100, 100));
    session.send({
      type: "pointer-move",
      pointerId: 1,
      position: { x: 106, y: 104 },
    });
    session.send({
      type: "pointer-up",
      pointerId: 1,
      position: { x: 106, y: 104 },
    });
    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      inputFamily: "simulated",
      activeParticipantCount: 1,
      participants: [
        {
          id: "simulated:1",
          pointerId: undefined,
          inputFamily: "simulated",
          position: { x: 100, y: 100 },
          createdAtMs: 100,
        },
      ],
    });

    session.send(directDown(8, 300, 300));
    expect(session.getSnapshot().activeParticipantCount).toBe(1);
    expect(effects.sounds).toEqual(["down"]);
  });

  it("removes the nearest simulated participant and breaks exact ties toward the newest", () => {
    const { effects, scheduler, session } = setup();
    clickMouse(session, 100, 100);
    clickMouse(session, 216, 100);
    const scheduledAfterAdds = scheduler.scheduledTaskCount();

    clickMouse(session, 158, 100);

    expect(session.getSnapshot().participants).toMatchObject([
      { id: "simulated:1", position: { x: 100, y: 100 } },
    ]);
    expect(effects.sounds).toEqual(["down", "down", "up"]);
    expect(scheduler.scheduledTaskCount()).toBe(scheduledAfterAdds);

    session.send({ type: "remove-latest-simulated" });
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      inputFamily: null,
      activeParticipantCount: 0,
    });
    expect(effects.sounds).toEqual(["down", "down", "up", "up"]);
  });

  it("gates collection sounds with the current preference", () => {
    const { effects, session } = setup({
      settings: { ...SETTINGS, soundEnabled: false },
    });

    session.send(directDown(1, 10, 10));
    session.send({ type: "pointer-up", pointerId: 1 });

    expect(effects.sounds).toEqual([]);
  });

  it("cancels scheduled work when destroyed", () => {
    const { scheduler, session } = setup();
    session.send(directDown(1, 10, 10));
    const scheduled = scheduler.latestTimeout();
    const snapshot = session.getSnapshot();

    session.destroy();
    scheduler.run(scheduled);

    expect(scheduled.cancelled).toBe(true);
    expect(session.getSnapshot()).toBe(snapshot);
  });
});

describe("createChooserSession Single selection", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back safely when selectionCount is %s",
    (selectionCount) => {
      const { scheduler, session } = setup({
        settings: { ...SETTINGS, selectionCount },
      });

      session.send(directDown(1, 10, 10, { color: { r: 10, g: 20, b: 30 } }));
      session.send(directDown(2, 20, 20, { color: { r: 40, g: 50, b: 60 } }));
      scheduler.run(scheduler.latestTimeout());

      const snapshot = session.getSnapshot();
      expect(snapshot.selectionCount).toBe(1);
      expect(singleResult(snapshot).selectedParticipantIds).toHaveLength(1);
      expect(Object.values(snapshot.background).every(Number.isFinite)).toBe(
        true,
      );
    },
  );

  it("keeps an equal-count round collecting because eligibility is strict", () => {
    const { effects, scheduler, session } = setup({
      settings: { ...SETTINGS, selectionCount: 2 },
    });

    session.send(directDown(1, 10, 10));
    session.send(directDown(2, 20, 20));
    const attempt = scheduler.latestTimeout();

    expect(attempt.delayMs).toBe(3000);
    scheduler.run(attempt);

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      activeParticipantCount: 2,
      result: null,
      background: { r: 0, g: 0, b: 0 },
    });
    expect(effects.sounds).toEqual(["down", "down"]);
    expect(effects.vibrations).toEqual([]);

    session.send(directDown(3, 30, 30));
    const nextAttempt = scheduler.latestTimeout();
    expect(nextAttempt).not.toBe(attempt);
    expect(nextAttempt.delayMs).toBe(3000);
    scheduler.run(nextAttempt);
    expect(session.getSnapshot().phase).toBe("result");
  });

  it("selects exactly without replacement, retires nonwinners, and persists after release", () => {
    const colors = new Map<number, ChooserColor>([
      [1, { r: 1, g: 12, b: 23 }],
      [2, { r: 8, g: 35, b: 62 }],
      [3, { r: 20, g: 58, b: 97 }],
    ]);
    const { effects, scheduler, session } = setup({
      random: createSequenceRandom([0.81, 0.19]),
      settings: { ...SETTINGS, selectionCount: 2 },
    });

    colors.forEach((color, pointerId) => {
      session.send(directDown(pointerId, pointerId * 10, 10, { color }));
    });
    const attempt = scheduler.latestTimeout();

    expect(session.getSnapshot().phase).toBe("collecting");
    scheduler.run(attempt);
    scheduler.run(attempt);

    const settled = session.getSnapshot();
    const result = singleResult(settled);
    const selectedIds = [...result.selectedParticipantIds];
    expect(selectedIds).toHaveLength(2);
    expect(new Set(selectedIds).size).toBe(2);
    expect(settled.phase).toBe("result");
    expect(settled.activeParticipantCount).toBe(0);
    expect(settled.controlsVisible).toBe(false);

    const selectedColors = selectedIds.map((id) => {
      const participant = settled.participants.find(
        (candidate) => candidate.id === id,
      );
      expect(participant).toBeDefined();
      return participant?.color ?? { r: 0, g: 0, b: 0 };
    });
    const expectedBackground = averageColor(selectedColors);

    expect(result.background).toEqual(expectedBackground);
    expect(settled.background).toEqual(expectedBackground);
    expect(settled.participants).toHaveLength(3);
    settled.participants.forEach((participant) => {
      expect(participant.state).toBe(
        selectedIds.includes(participant.id) ? "selected" : "retiring",
      );
    });
    expect(effects.sounds).toEqual(["down", "down", "down", "chosen"]);
    expect(effects.vibrations).toEqual([100]);

    session.send({ type: "pointer-up", pointerId: 1 });
    session.send({ type: "pointer-up", pointerId: 2 });
    session.send({ type: "pointer-up", pointerId: 3 });

    expect(session.getSnapshot()).toEqual(settled);
    expect(singleResult(session.getSnapshot())).toEqual(result);
    expect(effects.sounds).toEqual(["down", "down", "down", "chosen"]);
    expect(effects.vibrations).toEqual([100]);
  });

  it.each([
    { soundEnabled: false, vibrationEnabled: true },
    { soundEnabled: true, vibrationEnabled: false },
    { soundEnabled: false, vibrationEnabled: false },
  ])(
    "gates result feedback when sound=$soundEnabled and vibration=$vibrationEnabled",
    ({ soundEnabled, vibrationEnabled }) => {
      const { effects, scheduler, session } = setup({
        settings: {
          ...SETTINGS,
          soundEnabled,
          vibrationEnabled,
        },
      });

      session.send(directDown(1, 10, 10, { color: { r: 0, g: 0, b: 0 } }));
      session.send(
        directDown(2, 20, 20, { color: { r: 255, g: 255, b: 255 } }),
      );
      scheduler.run(scheduler.latestTimeout());

      expect(effects.sounds.filter((cue) => cue === "chosen")).toHaveLength(
        soundEnabled ? 1 : 0,
      );
      expect(effects.vibrations).toEqual(vibrationEnabled ? [100] : []);
    },
  );

  it("resolves a zero delay on the next animation frame", () => {
    const { scheduler, session } = setup({
      settings: { ...SETTINGS, singleDelayMs: 0 },
    });

    session.send(directDown(1, 10, 10, { color: { r: 5, g: 10, b: 15 } }));
    session.send(directDown(2, 20, 20, { color: { r: 25, g: 30, b: 35 } }));

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      result: null,
    });
    expect(scheduler.activeTimeouts()).toHaveLength(0);
    expect(scheduler.activeFrames()).toHaveLength(1);

    scheduler.run(scheduler.latestFrame());

    expect(session.getSnapshot().phase).toBe("result");
    expect(
      singleResult(session.getSnapshot()).selectedParticipantIds,
    ).toHaveLength(1);
  });

  it(
    "keeps all four Single winners reachable across 100,000 fixed-seed samples",
    { timeout: 30_000 },
    () => {
      const outcomeKeys = ["direct:1", "direct:2", "direct:3", "direct:4"];
      const counts = sampleSingleOutcomes({
        participantCount: 4,
        sampleCount: 100_000,
        seed: 0x4c11db7,
        selectionCount: 1,
        outcomeKeys,
      });

      expectChiSquareBelow(counts, 100_000, 16.2662362);
    },
  );

  it(
    "keeps all ten two-of-five subsets reachable across 100,000 fixed-seed samples",
    { timeout: 30_000 },
    () => {
      const outcomeKeys = combinations(
        ["direct:1", "direct:2", "direct:3", "direct:4", "direct:5"],
        2,
      ).map((ids) => ids.join("|"));
      const counts = sampleSingleOutcomes({
        participantCount: 5,
        sampleCount: 100_000,
        seed: 0x9e3779b9,
        selectionCount: 2,
        outcomeKeys,
      });

      expectChiSquareBelow(counts, 100_000, 27.8771649);
    },
  );
});

interface SetupOverrides {
  effects?: FakeEffects;
  random?: { next(): number };
  scheduler?: FakeScheduler;
  settings?: Readonly<ChooserSettings>;
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
    settings: overrides.settings ?? SETTINGS,
  });
  return { effects, scheduler, session };
}

function directDown(
  pointerId: number,
  x: number,
  y: number,
  overrides: {
    color?: { r: number; g: number; b: number };
    isPrimary?: boolean;
    pointerType?: "touch" | "pen";
  } = {},
) {
  return {
    type: "pointer-down" as const,
    button: 0,
    color: overrides.color,
    isPrimary: overrides.isPrimary ?? true,
    pointerId,
    pointerType: overrides.pointerType ?? ("touch" as const),
    position: { x, y },
  };
}

function mouseDown(pointerId: number, x: number, y: number, button = 0) {
  return {
    type: "pointer-down" as const,
    button,
    isPrimary: true,
    pointerId,
    pointerType: "mouse" as const,
    position: { x, y },
  };
}

function clickMouse(
  session: ReturnType<typeof createChooserSession>,
  x: number,
  y: number,
) {
  session.send(mouseDown(1, x, y));
  session.send({ type: "pointer-up", pointerId: 1 });
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

  activeFrames() {
    return this.tasks.filter(
      (task) => !task.cancelled && task.kind === "frame",
    );
  }

  activeTimeouts() {
    return this.tasks.filter(
      (task) => !task.cancelled && task.kind === "timeout",
    );
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

  latestFrame() {
    const task = this.tasks.findLast((candidate) => candidate.kind === "frame");
    if (task === undefined) {
      throw new Error("No animation frame was scheduled");
    }
    return task;
  }

  run(task: FakeTask) {
    task.callback();
  }

  scheduledTaskCount() {
    return this.tasks.length;
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
  readonly sounds: string[] = [];
  readonly vibrations: number[] = [];

  playSound(cue: "chosen" | "down" | "up") {
    this.sounds.push(cue);
  }

  vibrate(durationMs: 40 | 100) {
    this.vibrations.push(durationMs);
  }
}

interface SingleResultContract {
  readonly kind: "single";
  readonly selectedParticipantIds: readonly string[];
  readonly background: Readonly<ChooserColor>;
}

function singleResult(snapshot: Readonly<ChooserSnapshot>) {
  const result = snapshot.result;
  if (result?.kind !== "single") {
    throw new Error(
      `Expected a Single result, received ${result?.kind ?? "none"}`,
    );
  }
  return result as unknown as SingleResultContract;
}

function averageColor(colors: readonly Readonly<ChooserColor>[]) {
  const totals = colors.reduce(
    (sum, color) => ({
      r: sum.r + color.r,
      g: sum.g + color.g,
      b: sum.b + color.b,
    }),
    { r: 0, g: 0, b: 0 },
  );
  return {
    r: Math.floor(totals.r / colors.length),
    g: Math.floor(totals.g / colors.length),
    b: Math.floor(totals.b / colors.length),
  };
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

function sampleSingleOutcomes(options: {
  readonly participantCount: number;
  readonly sampleCount: number;
  readonly seed: number;
  readonly selectionCount: number;
  readonly outcomeKeys: readonly string[];
}) {
  const counts = new Map(options.outcomeKeys.map((key) => [key, 0]));
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
        ...SETTINGS,
        selectionCount: options.selectionCount,
        soundEnabled: false,
        vibrationEnabled: false,
      },
    });

    for (
      let pointerId = 1;
      pointerId <= options.participantCount;
      pointerId += 1
    ) {
      session.send(
        directDown(pointerId, pointerId, pointerId, {
          color: { r: pointerId, g: pointerId, b: pointerId },
        }),
      );
    }
    scheduler.run(scheduler.latestTimeout());

    const key = [...singleResult(session.getSnapshot()).selectedParticipantIds]
      .sort(compareParticipantIds)
      .join("|");
    const previousCount = counts.get(key);
    if (previousCount === undefined) {
      throw new Error(`Unexpected Single outcome: ${key}`);
    }
    counts.set(key, previousCount + 1);
    session.destroy();
  }

  return counts;
}

function compareParticipantIds(left: string, right: string) {
  return Number(left.split(":")[1]) - Number(right.split(":")[1]);
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
