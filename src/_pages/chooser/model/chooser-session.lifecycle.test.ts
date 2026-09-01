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
  type ChooserSession,
  type ChooserSnapshot,
} from "./chooser-session";

const SINGLE_SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  selectionMode: "single",
  selectionCount: 1,
  soundEnabled: true,
  vibrationEnabled: true,
  topPaddingPx: 0,
  circleSizePercent: 100,
  singleDelayMs: 1,
  groupDelayMs: 1,
  orderDelayMs: 1,
  singleLifetimeMs: 725,
  groupLifetimeMs: 850,
  orderLifetimeMs: 975,
});

const GROUP_SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  ...SINGLE_SETTINGS,
  selectionMode: "group",
  selectionCount: 2,
});

const ORDER_SETTINGS: Readonly<ChooserSettings> = Object.freeze({
  ...SINGLE_SETTINGS,
  selectionMode: "order",
  selectionCount: 1,
});

const BLACK: Readonly<ChooserColor> = Object.freeze({ r: 0, g: 0, b: 0 });
const INTERRUPT_REASONS = [
  "hidden",
  "pagehide",
  "resize",
  "orientationchange",
] as const;

type PublicEvent = Parameters<ChooserSession["send"]>[0];
type FutureLifecycleEvent =
  | { readonly type: "dismiss" }
  | {
      readonly type: "interrupt";
      readonly reason: (typeof INTERRUPT_REASONS)[number];
    };

describe("Chooser session reset and interruption lifecycle", () => {
  it("consumes one reset, invalidates stale work, and cleans up at the Single lifetime", () => {
    const fixture = setup();
    const { effects, scheduler, session } = fixture;
    const phases: string[] = [];
    let publications = 0;
    session.subscribe(() => {
      publications += 1;
      phases.push(session.getSnapshot().phase);
    });

    settleSingle(fixture);
    const settled = session.getSnapshot();
    const selectionTask = scheduler.latestTimeout();
    const publicationsBeforeReset = publications;
    const effectsBeforeReset = recordedEffects(effects);

    session.send(directDown(99));

    const resetting = session.getSnapshot();
    expect(resetting).toMatchObject({
      phase: "resetting",
      controlsVisible: false,
      inputFamily: null,
      activeParticipantCount: 0,
      result: settled.result,
      background: BLACK,
    });
    expect(resetting.result).toBe(settled.result);
    expect(resetting.participants).toHaveLength(2);
    expect(
      resetting.participants.some(
        (participant) => participant.id === "direct:99",
      ),
    ).toBe(false);
    expect(
      resetting.participants.every(
        (participant) => participant.state === "retiring",
      ),
    ).toBe(true);
    expect(scheduler.latestTimeout()).not.toBe(selectionTask);
    expect(scheduler.latestActiveTimeout().delayMs).toBe(
      SINGLE_SETTINGS.singleLifetimeMs,
    );
    expectRecordedEffects(effects, effectsBeforeReset);
    expect(publications).toBe(publicationsBeforeReset + 1);
    expect(phases.at(-1)).toBe("resetting");

    const resetSnapshot = session.getSnapshot();
    const resetTask = scheduler.latestActiveTimeout();
    session.send(directDown(100));
    sendLifecycleEvent(session, { type: "dismiss" });
    session.send({
      type: "pointer-move",
      pointerId: 1,
      position: { x: 901, y: 902 },
    });
    session.send({ type: "pointer-up", pointerId: 1 });
    session.send({ type: "pointer-cancel", pointerId: 1 });
    scheduler.run(selectionTask);

    expect(session.getSnapshot()).toBe(resetSnapshot);
    expect(scheduler.latestActiveTimeout()).toBe(resetTask);
    expect(publications).toBe(publicationsBeforeReset + 1);
    expectRecordedEffects(effects, effectsBeforeReset);
    expect(phases.filter((phase) => phase === "resetting")).toHaveLength(1);

    scheduler.run(resetTask);

    const cleaned = session.getSnapshot();
    expect(cleaned).toMatchObject({
      phase: "idle",
      controlsVisible: true,
      inputFamily: null,
      activeParticipantCount: 0,
      participants: [],
      result: null,
      background: BLACK,
    });
    expect(publications).toBe(publicationsBeforeReset + 2);
    expect(phases.slice(-2)).toEqual(["resetting", "idle"]);

    scheduler.run(resetTask);
    expect(session.getSnapshot()).toBe(cleaned);
    expect(publications).toBe(publicationsBeforeReset + 2);
    expect(phases.filter((phase) => phase === "resetting")).toHaveLength(1);
  });

  it.each([
    {
      label: "Group",
      settings: GROUP_SETTINGS,
      lifetimeMs: GROUP_SETTINGS.groupLifetimeMs,
      settle: settleGroup,
    },
    {
      label: "Order",
      settings: ORDER_SETTINGS,
      lifetimeMs: ORDER_SETTINGS.orderLifetimeMs,
      settle: settleOrder,
    },
  ])(
    "uses the configured $label lifetime directly for reset",
    ({ settings, lifetimeMs, settle }) => {
      const fixture = setup({ settings });
      const { effects, scheduler, session } = fixture;
      settle(fixture);
      const effectsBeforeReset = recordedEffects(effects);

      sendLifecycleEvent(session, { type: "dismiss" });

      expect(session.getSnapshot().phase).toBe("resetting");
      expect(scheduler.latestActiveTimeout().delayMs).toBe(lifetimeMs);
      expectRecordedEffects(effects, effectsBeforeReset);
    },
  );

  it.each([
    { label: "Single", settings: SINGLE_SETTINGS, settle: settleSingle },
    { label: "Group", settings: GROUP_SETTINGS, settle: settleGroup },
    { label: "Order", settings: ORDER_SETTINGS, settle: settleOrder },
  ])(
    "completes a zero-lifetime $label reset synchronously without a reset timer",
    ({ settings, settle }) => {
      const fixture = setup({
        settings: {
          ...settings,
          singleLifetimeMs: 0,
          groupLifetimeMs: 0,
          orderLifetimeMs: 0,
        },
      });
      const { scheduler, session } = fixture;
      settle(fixture);

      sendLifecycleEvent(session, { type: "dismiss" });

      expect(session.getSnapshot()).toMatchObject({
        phase: "idle",
        controlsVisible: true,
        inputFamily: null,
        activeParticipantCount: 0,
        participants: [],
        result: null,
        background: BLACK,
      });
      expect(scheduler.pendingTimeouts()).toHaveLength(0);
    },
  );

  it("resets partial Order reveal, cancels its callback, and rejects stale ranking", () => {
    const fixture = setup({ settings: ORDER_SETTINGS });
    const { effects, scheduler, session } = fixture;
    settleOrderFirstRank(fixture);
    const partial = session.getSnapshot();
    const partialResult = partial.result;
    const pendingOrder = scheduler.latestActiveTimeout();
    const effectsBeforeReset = recordedEffects(effects);

    session.send(directDown(99));

    const resetting = session.getSnapshot();
    expect(resetting).toMatchObject({
      phase: "resetting",
      controlsVisible: false,
      inputFamily: null,
      activeParticipantCount: 0,
      result: partialResult,
      background: BLACK,
    });
    expect(resetting.result).toEqual(partialResult);
    expect(orderResult(resetting).ranks).toHaveLength(1);
    expect(
      resetting.participants.every(
        (participant) => participant.state === "retiring",
      ),
    ).toBe(true);
    expect(pendingOrder.cancelled).toBe(true);

    const resetSnapshot = session.getSnapshot();
    scheduler.run(pendingOrder);
    expect(session.getSnapshot()).toBe(resetSnapshot);
    expect(orderResult(session.getSnapshot()).ranks).toHaveLength(1);
    expectRecordedEffects(effects, effectsBeforeReset);

    scheduler.run(scheduler.latestActiveTimeout());
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      controlsVisible: true,
      participants: [],
      result: null,
      background: BLACK,
    });
    expectRecordedEffects(effects, effectsBeforeReset);
  });

  it.each(INTERRUPT_REASONS)(
    "silently aborts a collecting round on %s and rejects its stale callback",
    (reason) => {
      const fixture = setup({ settings: SINGLE_SETTINGS });
      const { effects, scheduler, session } = fixture;
      session.send(directDown(1));
      const selectionTask = scheduler.latestActiveTimeout();
      const effectsBeforeInterrupt = recordedEffects(effects);

      sendLifecycleEvent(session, { type: "interrupt", reason });

      expect(session.getSnapshot()).toMatchObject({
        phase: "idle",
        controlsVisible: true,
        inputFamily: null,
        activeParticipantCount: 0,
        participants: [],
        result: null,
        background: BLACK,
      });
      expect(selectionTask.cancelled).toBe(true);
      expect(scheduler.pendingTimeouts()).toHaveLength(0);
      expectRecordedEffects(effects, effectsBeforeInterrupt);

      const aborted = session.getSnapshot();
      scheduler.run(selectionTask);
      expect(session.getSnapshot()).toBe(aborted);
      expectRecordedEffects(effects, effectsBeforeInterrupt);
    },
  );

  it.each(INTERRUPT_REASONS)(
    "silently aborts a partial Order reveal on %s, clears ranks, and rejects stale work",
    (reason) => {
      const fixture = setup({ settings: ORDER_SETTINGS });
      const { effects, scheduler, session } = fixture;
      settleOrderFirstRank(fixture);
      const pendingOrder = scheduler.latestActiveTimeout();
      const effectsBeforeInterrupt = recordedEffects(effects);

      sendLifecycleEvent(session, { type: "interrupt", reason });

      expect(session.getSnapshot()).toMatchObject({
        phase: "idle",
        controlsVisible: true,
        inputFamily: null,
        activeParticipantCount: 0,
        participants: [],
        result: null,
        background: BLACK,
      });
      expect(pendingOrder.cancelled).toBe(true);
      expectRecordedEffects(effects, effectsBeforeInterrupt);

      const aborted = session.getSnapshot();
      scheduler.run(pendingOrder);
      expect(session.getSnapshot()).toBe(aborted);
      expectRecordedEffects(effects, effectsBeforeInterrupt);
    },
  );

  it.each([
    { label: "Single", settings: SINGLE_SETTINGS, settle: settleSingle },
    { label: "Group", settings: GROUP_SETTINGS, settle: settleGroup },
    { label: "Order", settings: ORDER_SETTINGS, settle: settleOrder },
  ])(
    "keeps a settled $label result as an exact no-op for every interruption",
    ({ settings, settle }) => {
      const fixture = setup({ settings });
      const { session } = fixture;
      settle(fixture);
      const settled = session.getSnapshot();
      let publications = 0;
      session.subscribe(() => {
        publications += 1;
      });

      INTERRUPT_REASONS.forEach((reason) => {
        sendLifecycleEvent(session, { type: "interrupt", reason });
        expect(session.getSnapshot()).toBe(settled);
      });

      expect(publications).toBe(0);
    },
  );

  it("cancels a pending reset on destroy and rejects its stale callback", () => {
    const fixture = setup();
    const { scheduler, session } = fixture;
    settleSingle(fixture);
    sendLifecycleEvent(session, { type: "dismiss" });
    const resetTask = scheduler.latestActiveTimeout();
    const resetting = session.getSnapshot();
    let publications = 0;
    session.subscribe(() => {
      publications += 1;
    });

    session.destroy();

    expect(resetTask.cancelled).toBe(true);
    scheduler.run(resetTask);
    expect(session.getSnapshot()).toBe(resetting);
    expect(publications).toBe(0);
  });
});

interface SetupOverrides {
  readonly effects?: FakeEffects;
  readonly random?: { next(): number };
  readonly scheduler?: FakeScheduler;
  readonly settings?: Readonly<ChooserSettings>;
}

interface Fixture {
  readonly effects: FakeEffects;
  readonly scheduler: FakeScheduler;
  readonly session: ReturnType<typeof createChooserSession>;
}

function setup(overrides: SetupOverrides = {}): Fixture {
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  const effects = overrides.effects ?? new FakeEffects();
  let now = 100;
  const clock: ChooserClock = { now: () => now++ };
  const session = createChooserSession({
    clock,
    effects,
    random: overrides.random ?? { next: () => 0 },
    scheduler,
    settings: overrides.settings ?? SINGLE_SETTINGS,
  });
  return { effects, scheduler, session };
}

function directDown(pointerId: number) {
  return {
    type: "pointer-down" as const,
    button: 0,
    color: colorFor(pointerId),
    isPrimary: true,
    pointerId,
    pointerType: "touch" as const,
    position: { x: pointerId * 10, y: pointerId * 10 },
  };
}

function colorFor(pointerId: number): Readonly<ChooserColor> {
  return {
    r: pointerId,
    g: pointerId + 10,
    b: pointerId + 20,
  };
}

function addDirectParticipants(fixture: Fixture, count: number) {
  for (let pointerId = 1; pointerId <= count; pointerId += 1) {
    fixture.session.send(directDown(pointerId));
  }
}

function settleSingle(fixture: Fixture) {
  addDirectParticipants(fixture, 2);
  fixture.scheduler.run(fixture.scheduler.latestActiveTimeout());
}

function settleGroup(fixture: Fixture) {
  addDirectParticipants(fixture, 3);
  fixture.scheduler.run(fixture.scheduler.latestActiveTimeout());
}

function settleOrderFirstRank(fixture: Fixture) {
  addDirectParticipants(fixture, 3);
  fixture.scheduler.run(fixture.scheduler.latestActiveTimeout());
}

function settleOrder(fixture: Fixture) {
  settleOrderFirstRank(fixture);
  while (fixture.session.getSnapshot().phase !== "result") {
    fixture.scheduler.run(fixture.scheduler.latestActiveTimeout());
  }
}

function sendLifecycleEvent(
  session: ReturnType<typeof createChooserSession>,
  event: FutureLifecycleEvent,
) {
  session.send(event as unknown as PublicEvent);
}

function orderResult(snapshot: Readonly<ChooserSnapshot>) {
  const result = snapshot.result;
  if (result?.kind !== "order") {
    throw new Error(
      `Expected an Order result, received ${result?.kind ?? "none"}`,
    );
  }
  return result;
}

function recordedEffects(effects: FakeEffects) {
  return {
    sounds: [...effects.sounds],
    vibrations: [...effects.vibrations],
  };
}

function expectRecordedEffects(
  effects: FakeEffects,
  recorded: ReturnType<typeof recordedEffects>,
) {
  expect(effects.sounds).toEqual(recorded.sounds);
  expect(effects.vibrations).toEqual(recorded.vibrations);
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

  latestTimeout() {
    const task = this.tasks.findLast(
      (candidate) => candidate.kind === "timeout",
    );
    if (task === undefined) {
      throw new Error("No timeout was scheduled");
    }
    return task;
  }

  latestActiveTimeout() {
    const task = this.tasks.findLast(
      (candidate) =>
        candidate.kind === "timeout" && !candidate.cancelled && !candidate.ran,
    );
    if (task === undefined) {
      throw new Error("No active timeout was scheduled");
    }
    return task;
  }

  pendingTimeouts() {
    return this.tasks.filter(
      (task) => task.kind === "timeout" && !task.cancelled && !task.ran,
    );
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
      delayMs,
      kind,
      cancelled: false,
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
