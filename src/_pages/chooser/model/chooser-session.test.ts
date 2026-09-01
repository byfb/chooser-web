// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

import type { ChooserSettings } from "./chooser-settings";
import {
  createChooserSession,
  type ChooserClock,
  type ChooserEffects,
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

interface SetupOverrides {
  scheduler?: FakeScheduler;
  settings?: Readonly<ChooserSettings>;
}

function setup(overrides: SetupOverrides = {}) {
  const scheduler = overrides.scheduler ?? new FakeScheduler();
  const effects = new FakeEffects();
  let now = 100;
  const clock: ChooserClock = {
    now: () => now++,
  };
  const session = createChooserSession({
    clock,
    effects,
    random: { next: () => 0.25 },
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
