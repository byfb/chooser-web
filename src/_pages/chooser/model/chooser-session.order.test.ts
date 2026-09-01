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
  type ChooserSnapshot,
} from "./chooser-session";

const ORDER_SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  selectionMode: "order",
  selectionCount: 1,
  soundEnabled: true,
  vibrationEnabled: true,
  topPaddingPx: 0,
  circleSizePercent: 100,
  singleDelayMs: 3000,
  groupDelayMs: 3000,
  orderDelayMs: 1200,
  singleLifetimeMs: 1000,
  groupLifetimeMs: 1000,
  orderLifetimeMs: 1500,
});

describe("Order selection public contract", () => {
  it("requires two participants and starts a fresh attempt after an ineligible callback", () => {
    const { effects, scheduler, session } = setup();
    session.send(directDown(1));
    const ineligibleAttempt = scheduler.latestTimeout();

    expect(ineligibleAttempt.delayMs).toBe(1200);
    scheduler.run(ineligibleAttempt);
    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      activeParticipantCount: 1,
      result: null,
    });

    session.send(directDown(2));
    const eligibleAttempt = scheduler.latestTimeout();
    expect(eligibleAttempt).not.toBe(ineligibleAttempt);
    scheduler.run(eligibleAttempt);

    expect(session.getSnapshot()).toMatchObject({
      phase: "order-revealing",
      activeParticipantCount: 1,
    });
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(1);
    expect(effects.sounds).toEqual(["down", "down", "up"]);
    expect(effects.vibrations).toEqual([40]);
  });

  it("defers a zero Order delay until the next animation frame", () => {
    const { scheduler, session } = setup({
      settings: { ...ORDER_SETTINGS, orderDelayMs: 0 },
    });
    session.send(directDown(1));
    session.send(directDown(2));

    expect(session.getSnapshot()).toMatchObject({
      phase: "collecting",
      result: null,
    });
    expect(scheduler.pendingFrames()).toHaveLength(1);
    expect(scheduler.pendingTimeouts()).toHaveLength(0);

    scheduler.run(scheduler.latestFrame());
    expect(session.getSnapshot().phase).toBe("order-revealing");
    expect(orderResult(session.getSnapshot()).ranks).toMatchObject([
      { rank: 1 },
    ]);
  });

  it("uses dynamic membership, current-count cadence, and stale-safe callbacks", () => {
    const { effects, scheduler, session } = setup({
      random: createSequenceRandom([0.1, 0.8, 0.2, 0.7]),
    });
    addDirectParticipants(session, 4);
    const firstAttempt = scheduler.latestTimeout();
    scheduler.run(firstAttempt);

    const firstSnapshot = session.getSnapshot();
    const firstResult = orderResult(firstSnapshot);
    const firstRanked = firstResult.ranks[0];
    expect(firstRanked).toBeDefined();
    expect(firstSnapshot.phase).toBe("order-revealing");
    expect(firstResult.ranks).toEqual([
      { participantId: firstRanked?.participantId, rank: 1 },
    ]);

    const secondReveal = scheduler.latestTimeout();
    expect(secondReveal.delayMs).toBe(750);
    const unranked = firstSnapshot.participants.find(
      (participant) => participant.state === "active",
    );
    expect(unranked).toBeDefined();
    const unrankedPointerId = unranked?.pointerId;
    const rankedPointerId = participantPointerId(
      firstSnapshot,
      firstRanked?.participantId,
    );
    expect(unrankedPointerId).toBeDefined();
    expect(rankedPointerId).toBeDefined();

    session.send({ type: "pointer-up", pointerId: unrankedPointerId ?? -1 });
    session.send({ type: "pointer-up", pointerId: rankedPointerId ?? -1 });
    session.send({ type: "pointer-cancel", pointerId: rankedPointerId ?? -1 });
    session.send({
      type: "lost-pointer-capture",
      pointerId: rankedPointerId ?? -1,
    });

    expect(
      session
        .getSnapshot()
        .participants.some((participant) => participant.id === unranked?.id),
    ).toBe(false);
    expect(
      session
        .getSnapshot()
        .participants.some(
          (participant) => participant.id === firstRanked?.participantId,
        ),
    ).toBe(true);

    scheduler.run(secondReveal);
    const afterSecond = session.getSnapshot();
    expect(orderResult(afterSecond).ranks.map((rank) => rank.rank)).toEqual([
      1, 2,
    ]);
    const thirdReveal = scheduler.latestTimeout();
    expect(thirdReveal.delayMs).toBe(800);

    const effectsBeforeStale = {
      sounds: [...effects.sounds],
      vibrations: [...effects.vibrations],
    };
    scheduler.run(secondReveal);
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(2);
    expect(scheduler.latestTimeout()).toBe(thirdReveal);
    expect(effects.sounds).toEqual(effectsBeforeStale.sounds);
    expect(effects.vibrations).toEqual(effectsBeforeStale.vibrations);

    scheduler.run(thirdReveal);
    const settled = session.getSnapshot();
    const result = orderResult(settled);
    expect(settled).toMatchObject({
      phase: "result",
      controlsVisible: false,
      activeParticipantCount: 0,
      background: { r: 0, g: 0, b: 0 },
    });
    expect(result.ranks.map((rank) => rank.rank)).toEqual([1, 2, 3]);
    expect(new Set(result.ranks.map((rank) => rank.participantId)).size).toBe(
      3,
    );
    expect(result.ranks.map((rank) => rank.participantId)).not.toContain(
      unranked?.id,
    );
    expect(result.ranks.map((rank) => rank.participantId)).toContain(
      firstRanked?.participantId,
    );
    expect(effects.sounds).toEqual([
      "down",
      "down",
      "down",
      "down",
      "up",
      "up",
      "up",
    ]);
    expect(effects.vibrations).toEqual([40, 40, 40]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ranks)).toBe(true);
    result.ranks.forEach((rank) => expect(Object.isFrozen(rank)).toBe(true));
    expect(Object.isFrozen(result.background)).toBe(true);

    result.ranks.forEach((rank) => {
      const participant = settled.participants.find(
        (candidate) => candidate.id === rank.participantId,
      ) as RankedParticipantContract | undefined;
      expect(participant).toMatchObject({ state: "ranked", rank: rank.rank });
    });

    const beforeTerminalEvents = session.getSnapshot();
    settled.participants.forEach((participant) => {
      if (participant.pointerId !== undefined) {
        session.send({ type: "pointer-up", pointerId: participant.pointerId });
      }
    });
    expect(session.getSnapshot()).toBe(beforeTerminalEvents);
  });

  it("waits for the pending reveal callback when every unranked participant is released", () => {
    const { effects, scheduler, session } = setup();
    addDirectParticipants(session, 3);
    scheduler.run(scheduler.latestTimeout());

    const rankedId = orderResult(session.getSnapshot()).ranks[0]?.participantId;
    session.getSnapshot().participants.forEach((participant) => {
      if (participant.id !== rankedId && participant.pointerId !== undefined) {
        session.send({
          type: "pointer-cancel",
          pointerId: participant.pointerId,
        });
      }
    });

    expect(session.getSnapshot().phase).toBe("order-revealing");
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(1);
    const pendingReveal = scheduler.latestTimeout();
    scheduler.run(pendingReveal);

    expect(session.getSnapshot().phase).toBe("result");
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(1);
    expect(effects.sounds.filter((cue) => cue === "up")).toHaveLength(1);
    expect(effects.vibrations).toEqual([40]);
  });

  it.each([
    { soundEnabled: false, vibrationEnabled: true },
    { soundEnabled: true, vibrationEnabled: false },
  ])(
    "gates Order feedback when sound=$soundEnabled and vibration=$vibrationEnabled",
    ({ soundEnabled, vibrationEnabled }) => {
      const { effects, scheduler, session } = setup({
        settings: {
          ...ORDER_SETTINGS,
          soundEnabled,
          vibrationEnabled,
        },
      });
      addDirectParticipants(session, 3);
      runUntilResult(session, scheduler);

      expect(effects.sounds).toEqual(
        soundEnabled ? ["down", "down", "down", "up", "up", "up"] : [],
      );
      expect(effects.vibrations).toEqual(vibrationEnabled ? [40, 40, 40] : []);
    },
  );

  it("keeps revealing when feedback effects fail", () => {
    const effects = new ThrowingEffects();
    const { scheduler, session } = setup({ effects });
    addDirectParticipants(session, 3);
    runUntilResult(session, scheduler);

    expect(session.getSnapshot().phase).toBe("result");
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(3);
    expect(effects.sounds).toEqual(["down", "down", "down", "up", "up", "up"]);
    expect(effects.vibrations).toEqual([40, 40, 40]);
  });

  it("cancels pending Order work when destroyed and rejects its stale callback", () => {
    const { scheduler, session } = setup();
    addDirectParticipants(session, 3);
    scheduler.run(scheduler.latestTimeout());
    const pendingReveal = scheduler.latestTimeout();
    const snapshot = session.getSnapshot();

    session.destroy();
    expect(pendingReveal.cancelled).toBe(true);
    scheduler.run(pendingReveal);
    expect(session.getSnapshot()).toBe(snapshot);
  });

  it(
    "keeps all 120 five-participant orders reachable across 100,000 fixed-seed samples",
    { timeout: 30_000 },
    () => {
      const participantIds = Array.from(
        { length: 5 },
        (_, index) => `direct:${index + 1}`,
      );
      const outcomeKeys = permutations(participantIds).map((ids) =>
        ids.join("|"),
      );
      const counts = sampleOrderOutcomes({
        outcomeKeys,
        sampleCount: 100_000,
        seed: 0x243f6a88,
      });

      expect(counts.size).toBe(120);
      expectChiSquareBelow(counts, 100_000, 172.4176816);
    },
  );
});

interface OrderResultContract {
  readonly kind: "order";
  readonly ranks: readonly Readonly<{
    readonly participantId: string;
    readonly rank: number;
  }>[];
  readonly background: Readonly<ChooserColor>;
}

interface RankedParticipantContract {
  readonly id: string;
  readonly state: "ranked";
  readonly rank: number;
}

interface SetupOverrides {
  readonly effects?: FakeEffects;
  readonly random?: { next(): number };
  readonly scheduler?: FakeScheduler;
  readonly settings?: Readonly<ChooserSettings>;
}

function setup(overrides: SetupOverrides = {}) {
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  const effects = overrides.effects ?? new FakeEffects();
  let now = 100;
  const clock: ChooserClock = { now: () => now++ };
  const session = createChooserSession({
    clock,
    effects,
    random: overrides.random ?? { next: () => 0.25 },
    scheduler,
    settings: overrides.settings ?? ORDER_SETTINGS,
  });
  return { effects, scheduler, session };
}

function directDown(pointerId: number) {
  return {
    type: "pointer-down" as const,
    button: 0,
    color: {
      r: pointerId * 20,
      g: pointerId * 20 + 1,
      b: pointerId * 20 + 2,
    },
    isPrimary: pointerId === 1,
    pointerId,
    pointerType: "touch" as const,
    position: { x: pointerId * 10, y: pointerId * 10 },
  };
}

function addDirectParticipants(
  session: ReturnType<typeof createChooserSession>,
  count: number,
) {
  for (let pointerId = 1; pointerId <= count; pointerId += 1) {
    session.send(directDown(pointerId));
  }
}

function orderResult(snapshot: Readonly<ChooserSnapshot>) {
  const result = snapshot.result as unknown as OrderResultContract | null;
  if (result?.kind !== "order") {
    throw new Error(
      `Expected an Order result, received ${result?.kind ?? "none"}`,
    );
  }
  return result;
}

function participantPointerId(
  snapshot: Readonly<ChooserSnapshot>,
  participantId: string | undefined,
) {
  return snapshot.participants.find(
    (participant) => participant.id === participantId,
  )?.pointerId;
}

function runUntilResult(
  session: ReturnType<typeof createChooserSession>,
  scheduler: FakeScheduler,
) {
  for (let step = 0; step < 20; step += 1) {
    if (session.getSnapshot().phase === "result") {
      return;
    }
    scheduler.run(scheduler.nextPending());
  }
  throw new Error("Order did not settle within 20 scheduled callbacks");
}

interface FakeTask {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly kind: "frame" | "timeout";
  cancelled: boolean;
  ran: boolean;
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

  latestFrame() {
    const task = this.tasks.findLast((candidate) => candidate.kind === "frame");
    if (task === undefined) {
      throw new Error("No animation frame was scheduled");
    }
    return task;
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

  pendingFrames() {
    return this.tasks.filter(
      (task) => !task.cancelled && !task.ran && task.kind === "frame",
    );
  }

  pendingTimeouts() {
    return this.tasks.filter(
      (task) => !task.cancelled && !task.ran && task.kind === "timeout",
    );
  }

  nextPending() {
    const task = this.tasks.find(
      (candidate) => !candidate.cancelled && !candidate.ran,
    );
    if (task === undefined) {
      throw new Error("No scheduled callback is pending");
    }
    return task;
  }

  run(task: FakeTask) {
    task.ran = true;
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
    const task: FakeTask = {
      callback,
      cancelled: false,
      delayMs,
      kind,
      ran: false,
    };
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

function sampleOrderOutcomes(options: {
  readonly outcomeKeys: readonly string[];
  readonly sampleCount: number;
  readonly seed: number;
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
        ...ORDER_SETTINGS,
        orderDelayMs: 1,
        soundEnabled: false,
        vibrationEnabled: false,
      },
    });
    addDirectParticipants(session, 5);
    runUntilResult(session, scheduler);

    const key = orderResult(session.getSnapshot())
      .ranks.map((rank) => rank.participantId)
      .join("|");
    const previousCount = counts.get(key);
    if (previousCount === undefined) {
      throw new Error(`Unexpected Order outcome: ${key}`);
    }
    counts.set(key, previousCount + 1);
    session.destroy();
  }
  return counts;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) {
    return [[]];
  }
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (rest) => [value, ...rest],
    ),
  );
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
