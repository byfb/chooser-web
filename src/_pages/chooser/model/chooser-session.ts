// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChooserSettings, SelectionMode } from "./chooser-settings";

/** The input family that owns a collecting round. */
export type ChooserInputFamily = "direct" | "simulated";

/** The complete phase vocabulary is declared here so later selection slices can extend the model without changing its public shape. */
export type ChooserPhase =
  "idle" | "collecting" | "order-revealing" | "result" | "resetting";

export interface ChooserPosition {
  readonly x: number;
  readonly y: number;
}

export interface ChooserColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface ChooserParticipant {
  readonly id: string;
  readonly pointerId: number | undefined;
  readonly inputFamily: ChooserInputFamily;
  readonly position: Readonly<ChooserPosition>;
  readonly color: Readonly<ChooserColor>;
  readonly createdAtMs: number;
  readonly state: "active" | "selected" | "retiring" | "grouped" | "ranked";
  readonly rank?: number;
  readonly groupId?: number;
  readonly targetColor?: Readonly<ChooserColor>;
}

/** The settled result shapes for the supported selection modes. */
export type ChooserResult =
  | Readonly<{
      readonly kind: "single";
      readonly selectedParticipantIds: readonly string[];
      readonly background: Readonly<ChooserColor>;
    }>
  | Readonly<{
      readonly kind: "group";
      readonly groups: readonly Readonly<{
        readonly groupId: number;
        readonly participantIds: readonly string[];
        readonly color: Readonly<ChooserColor>;
      }>[];
      readonly background: Readonly<ChooserColor>;
    }>
  | Readonly<{
      readonly kind: "order";
      readonly ranks: readonly Readonly<{
        readonly participantId: string;
        readonly rank: number;
      }>[];
      readonly background: Readonly<ChooserColor>;
    }>;

export interface ChooserSnapshot {
  readonly phase: ChooserPhase;
  readonly selectionMode: SelectionMode;
  readonly selectionCount: number;
  readonly controlsVisible: boolean;
  readonly inputFamily: ChooserInputFamily | null;
  readonly activeParticipantCount: number;
  readonly participants: readonly Readonly<ChooserParticipant>[];
  readonly result: ChooserResult | null;
  readonly background: Readonly<ChooserColor>;
}

export interface ChooserClock {
  /** A monotonic timestamp source. */
  now(): number;
}

export interface ChooserScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  requestAnimationFrame(callback: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
}

export interface ChooserEffects {
  playSound(cue: "chosen" | "down" | "up"): void;
  vibrate(durationMs: 40 | 100): void;
}

export type ChooserPointerType = "mouse" | "pen" | "touch" | "trackpad";

export type ChooserInterruptReason =
  "hidden" | "pagehide" | "resize" | "orientationchange";

export type ChooserEvent =
  | {
      readonly type: "settings-changed";
      readonly settings: Readonly<ChooserSettings>;
    }
  | {
      readonly type: "pointer-down";
      readonly button: number;
      readonly isPrimary: boolean;
      readonly pointerId: number;
      readonly pointerType: ChooserPointerType;
      readonly position: Readonly<ChooserPosition>;
      readonly color?: Readonly<ChooserColor> | undefined;
    }
  | {
      readonly type: "pointer-move";
      readonly pointerId: number;
      readonly position: Readonly<ChooserPosition>;
    }
  | {
      readonly type: "pointer-up";
      readonly pointerId: number;
      readonly position?: Readonly<ChooserPosition>;
    }
  | {
      readonly type: "pointer-cancel";
      readonly pointerId: number;
    }
  | {
      readonly type: "lost-pointer-capture";
      readonly pointerId: number;
    }
  | {
      readonly type: "remove-latest-simulated";
    }
  | {
      readonly type: "dismiss";
    }
  | {
      readonly type: "interrupt";
      readonly reason: ChooserInterruptReason;
    };

export type ChooserSessionListener = () => void;

export interface ChooserSession {
  getSnapshot(): ChooserSnapshot;
  subscribe(listener: ChooserSessionListener): () => void;
  send(event: ChooserEvent): void;
  destroy(): void;
}

interface InternalParticipant {
  readonly id: string;
  readonly pointerId: number | undefined;
  readonly inputFamily: ChooserInputFamily;
  position: ChooserPosition;
  readonly color: ChooserColor;
  readonly createdAtMs: number;
  state: ChooserParticipant["state"];
  rank?: number;
  groupId?: number;
  targetColor?: ChooserColor;
}

interface PendingMouseActivation {
  readonly pointerId: number;
  readonly position: ChooserPosition;
  moved: boolean;
}

interface ScheduledSelection {
  readonly kind: "frame" | "timeout";
  readonly handle: unknown;
  readonly generation: number;
}

interface ScheduledOrder {
  readonly handle: unknown;
  readonly token: number;
}

interface ScheduledReset {
  readonly generation: number;
  readonly handle: unknown;
  readonly token: number;
}

type OrderRank = Readonly<{
  readonly participantId: string;
  readonly rank: number;
}>;

const DEFAULT_POSITION: ChooserPosition = Object.freeze({ x: 0, y: 0 });
const DEFAULT_COLOR: ChooserColor = Object.freeze({ r: 0, g: 0, b: 0 });
const GROUP_PARTICIPANT_COLOR: ChooserColor = Object.freeze({
  r: 255,
  g: 255,
  b: 255,
});
const MOUSE_CLICK_MOVEMENT_TOLERANCE_PX = 10;

/**
 * Owns the collecting phase of a Chooser round.
 *
 * Browser APIs are intentionally represented by ports. This keeps pointer
 * semantics deterministic in tests and lets the UI adapt DOM events without
 * leaking browser objects into the page model.
 */
export function createChooserSession(options: {
  readonly clock: ChooserClock;
  readonly effects: ChooserEffects;
  readonly random: { next(): number };
  readonly scheduler: ChooserScheduler;
  readonly settings: Readonly<ChooserSettings>;
}): ChooserSession {
  const listeners = new Set<ChooserSessionListener>();
  const participants: InternalParticipant[] = [];
  const pendingMouseActivations = new Map<number, PendingMouseActivation>();

  let settings = normalizeSettings(options.settings);
  let phase: ChooserPhase = "idle";
  let inputFamily: ChooserInputFamily | null = null;
  let selectionWork: ScheduledSelection | undefined;
  let orderWork: ScheduledOrder | undefined;
  let resetWork: ScheduledReset | undefined;
  let orderToken = 0;
  let resetToken = 0;
  let orderRanks: readonly OrderRank[] = Object.freeze([]);
  let generation = 0;
  let simulatedSequence = 0;
  let destroyed = false;
  let result: ChooserResult | null = null;
  let background = cloneColor(DEFAULT_COLOR);
  let snapshot = createSnapshot();

  const session: ChooserSession = {
    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      if (destroyed) {
        return () => undefined;
      }

      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    send(event) {
      if (destroyed) {
        return;
      }

      switch (event.type) {
        case "settings-changed":
          handleSettingsChanged(event.settings);
          return;
        case "pointer-down":
          handlePointerDown(event);
          return;
        case "pointer-move":
          handlePointerMove(event);
          return;
        case "pointer-up":
          handlePointerUp(event.pointerId, event.position);
          return;
        case "pointer-cancel":
          clearPendingMouse(event.pointerId);
          removeDirectParticipant(event.pointerId, false);
          return;
        case "lost-pointer-capture":
          clearPendingMouse(event.pointerId);
          removeDirectParticipant(event.pointerId, false);
          return;
        case "remove-latest-simulated":
          removeLatestSimulatedParticipant();
          return;
        case "dismiss":
          beginReset();
          return;
        case "interrupt":
          handleInterrupt();
          return;
      }
    },

    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      generation += 1;
      cancelSelectionWork();
      cancelOrderWork();
      cancelResetWork();
      pendingMouseActivations.clear();
      listeners.clear();
    },
  };

  return session;

  function handleSettingsChanged(nextSettings: Readonly<ChooserSettings>) {
    if (phase !== "idle") {
      return;
    }

    const normalized = normalizeSettings(nextSettings);
    if (settingsEqual(settings, normalized)) {
      return;
    }

    settings = normalized;
    publish();
  }

  function handlePointerDown(
    event: Extract<ChooserEvent, { type: "pointer-down" }>,
  ) {
    if (event.button !== 0) {
      return;
    }

    if (phase === "result" || phase === "order-revealing") {
      beginReset();
      return;
    }

    if (phase === "resetting") {
      return;
    }

    if (isDirectPointer(event.pointerType)) {
      handleDirectPointerDown(event);
      return;
    }

    if (isSimulatedPointer(event.pointerType)) {
      handleSimulatedPointerDown(event);
    }
  }

  function handleDirectPointerDown(
    event: Extract<ChooserEvent, { type: "pointer-down" }>,
  ) {
    if (inputFamily !== null && inputFamily !== "direct") {
      return;
    }

    if (phase !== "idle" && phase !== "collecting") {
      return;
    }

    if (
      participants.some(
        (participant) => participant.pointerId === event.pointerId,
      )
    ) {
      return;
    }

    pendingMouseActivations.clear();
    beginCollecting("direct");

    const participant: InternalParticipant = {
      id: `direct:${event.pointerId}`,
      pointerId: event.pointerId,
      inputFamily: "direct",
      position: clonePosition(event.position),
      color:
        settings.selectionMode === "group"
          ? cloneColor(GROUP_PARTICIPANT_COLOR)
          : cloneColor(event.color ?? randomColor()),
      createdAtMs: options.clock.now(),
      state: "active",
    };
    participants.push(participant);
    generation += 1;
    scheduleSelectionAttempt();
    playSound("down");
    publish();
  }

  function handleSimulatedPointerDown(
    event: Extract<ChooserEvent, { type: "pointer-down" }>,
  ) {
    if (event.isPrimary !== true) {
      return;
    }

    if (inputFamily !== null && inputFamily !== "simulated") {
      return;
    }

    if (phase !== "idle" && phase !== "collecting") {
      return;
    }

    if (pendingMouseActivations.has(event.pointerId)) {
      return;
    }

    pendingMouseActivations.set(event.pointerId, {
      pointerId: event.pointerId,
      position: clonePosition(event.position),
      moved: false,
    });
  }

  function handlePointerMove(
    event: Extract<ChooserEvent, { type: "pointer-move" }>,
  ) {
    const participant = participants.find(
      (candidate) => candidate.pointerId === event.pointerId,
    );
    if (participant?.inputFamily === "direct" && inputFamily === "direct") {
      participant.position = clonePosition(event.position);
      publish();
      return;
    }

    const pending = pendingMouseActivations.get(event.pointerId);
    if (pending === undefined) {
      return;
    }

    if (
      distance(pending.position, event.position) >
      MOUSE_CLICK_MOVEMENT_TOLERANCE_PX
    ) {
      pending.moved = true;
    }
  }

  function handlePointerUp(
    pointerId: number,
    position: Readonly<ChooserPosition> | undefined,
  ) {
    if (removeDirectParticipant(pointerId, true)) {
      return;
    }

    const pending = pendingMouseActivations.get(pointerId);
    if (pending === undefined) {
      return;
    }

    pendingMouseActivations.delete(pointerId);
    if (
      position !== undefined &&
      distance(pending.position, position) > MOUSE_CLICK_MOVEMENT_TOLERANCE_PX
    ) {
      pending.moved = true;
    }
    if (pending.moved || inputFamily === "direct") {
      return;
    }

    if (inputFamily !== null && inputFamily !== "simulated") {
      return;
    }

    if (phase !== "idle" && phase !== "collecting") {
      pendingMouseActivations.delete(pointerId);
      return;
    }

    const removalIndex = findHitSimulatedParticipant(pending.position);
    if (removalIndex >= 0) {
      participants.splice(removalIndex, 1);
      playSound("up");
      finishIfEmpty();
      publish();
      return;
    }

    beginCollecting("simulated");
    participants.push({
      id: `simulated:${++simulatedSequence}`,
      pointerId: undefined,
      inputFamily: "simulated",
      position: clonePosition(pending.position),
      color:
        settings.selectionMode === "group"
          ? cloneColor(GROUP_PARTICIPANT_COLOR)
          : cloneColor(randomColor()),
      createdAtMs: options.clock.now(),
      state: "active",
    });
    generation += 1;
    scheduleSelectionAttempt();
    playSound("down");
    publish();
  }

  function removeDirectParticipant(pointerId: number, deliberate: boolean) {
    if (phase === "order-revealing") {
      return removeOrderDirectParticipant(pointerId);
    }

    if (phase !== "collecting") {
      return false;
    }

    const index = participants.findIndex(
      (participant) =>
        participant.state === "active" &&
        participant.inputFamily === "direct" &&
        participant.pointerId === pointerId,
    );
    if (index < 0) {
      return false;
    }

    participants.splice(index, 1);
    if (deliberate) {
      playSound("up");
    }
    finishIfEmpty();
    publish();
    return true;
  }

  function removeOrderDirectParticipant(pointerId: number) {
    const index = participants.findIndex(
      (participant) =>
        participant.state === "active" &&
        participant.inputFamily === "direct" &&
        participant.pointerId === pointerId,
    );
    if (index < 0) {
      return false;
    }

    participants.splice(index, 1);
    publish();
    return true;
  }

  function removeLatestSimulatedParticipant() {
    if (phase !== "collecting" || inputFamily !== "simulated") {
      return;
    }

    const index = findLastSimulatedParticipantIndex();
    if (index < 0) {
      return;
    }

    participants.splice(index, 1);
    playSound("up");
    finishIfEmpty();
    publish();
  }

  function finishIfEmpty() {
    if (participants.length > 0) {
      return;
    }

    phase = "idle";
    inputFamily = null;
    generation += 1;
    cancelSelectionWork();
    pendingMouseActivations.clear();
  }

  function beginCollecting(family: ChooserInputFamily) {
    if (phase === "idle") {
      phase = "collecting";
      inputFamily = family;
    }
  }

  function clearPendingMouse(pointerId: number) {
    pendingMouseActivations.delete(pointerId);
  }

  function beginReset() {
    if (phase !== "result" && phase !== "order-revealing") {
      return;
    }

    generation += 1;
    cancelSelectionWork();
    cancelOrderWork();
    cancelResetWork();
    pendingMouseActivations.clear();
    inputFamily = null;
    background = cloneColor(DEFAULT_COLOR);
    participants.forEach((participant) => {
      participant.state = "retiring";
    });
    phase = "resetting";

    const resetGeneration = generation;
    const lifetimeMs = modeLifetime(settings);
    if (lifetimeMs <= 0) {
      completeReset(resetGeneration);
      return;
    }

    const token = ++resetToken;
    const handle = options.scheduler.setTimeout(() => {
      if (!isCurrentReset(resetGeneration, token)) {
        return;
      }

      resetWork = undefined;
      completeReset(resetGeneration);
    }, lifetimeMs);
    resetWork = { generation: resetGeneration, handle, token };
    publish();
  }

  function completeReset(resetGeneration: number) {
    if (destroyed || phase !== "resetting" || generation !== resetGeneration) {
      return;
    }

    generation += 1;
    participants.length = 0;
    pendingMouseActivations.clear();
    orderRanks = Object.freeze([]);
    result = null;
    background = cloneColor(DEFAULT_COLOR);
    inputFamily = null;
    phase = "idle";
    publish();
  }

  function handleInterrupt() {
    if (phase !== "collecting" && phase !== "order-revealing") {
      return;
    }

    generation += 1;
    cancelSelectionWork();
    cancelOrderWork();
    cancelResetWork();
    pendingMouseActivations.clear();
    participants.length = 0;
    orderRanks = Object.freeze([]);
    result = null;
    background = cloneColor(DEFAULT_COLOR);
    inputFamily = null;
    phase = "idle";
    publish();
  }

  function scheduleSelectionAttempt() {
    cancelSelectionWork();

    const scheduledGeneration = generation;
    const delayMs = modeDelay(settings);
    if (delayMs <= 0) {
      const handle = options.scheduler.requestAnimationFrame(() => {
        if (!isCurrentSelection(scheduledGeneration)) {
          return;
        }
        finishSelectionAttempt(scheduledGeneration);
      });
      selectionWork = {
        kind: "frame",
        handle,
        generation: scheduledGeneration,
      };
      return;
    }

    const handle = options.scheduler.setTimeout(() => {
      if (!isCurrentSelection(scheduledGeneration)) {
        return;
      }
      finishSelectionAttempt(scheduledGeneration);
    }, delayMs);
    selectionWork = {
      kind: "timeout",
      handle,
      generation: scheduledGeneration,
    };
  }

  function finishSelectionAttempt(scheduledGeneration: number) {
    selectionWork = undefined;

    if (settings.selectionMode === "order") {
      if (activeParticipantCount() < 2) {
        return;
      }

      startOrderReveal(scheduledGeneration);
      return;
    }

    if (
      (settings.selectionMode !== "single" &&
        settings.selectionMode !== "group") ||
      activeParticipantCount() <= settings.selectionCount
    ) {
      return;
    }

    if (settings.selectionMode === "single") {
      settleSingle(scheduledGeneration);
    } else {
      settleGroup(scheduledGeneration);
    }
  }

  function startOrderReveal(scheduledGeneration: number) {
    if (generation !== scheduledGeneration || phase !== "collecting") {
      return;
    }

    phase = "order-revealing";
    background = cloneColor(DEFAULT_COLOR);
    orderRanks = Object.freeze([]);
    revealOrderRank();
  }

  function revealOrderRank() {
    const candidates = participants.filter(
      (participant) => participant.state === "active",
    );
    if (candidates.length === 0) {
      settleOrder();
      return;
    }

    const participant =
      candidates[Math.floor(randomFraction() * candidates.length)];
    if (participant === undefined) {
      settleOrder();
      return;
    }

    const rank = Object.freeze({
      participantId: participant.id,
      rank: orderRanks.length + 1,
    });
    participant.state = "ranked";
    participant.rank = rank.rank;
    orderRanks = Object.freeze([...orderRanks, rank]);
    result = createOrderResult(orderRanks);
    playSound("up");
    vibrate(40);

    if (participants.some((candidate) => candidate.state === "active")) {
      scheduleOrderReveal();
      publish();
      return;
    }

    settleOrder();
  }

  function scheduleOrderReveal() {
    cancelOrderWork();

    const token = ++orderToken;
    const visibleCount = participants.reduce(
      (count, participant) =>
        count +
        (participant.state === "active" || participant.state === "ranked"
          ? 1
          : 0),
      0,
    );
    const delayMs = Math.min(3000 / visibleCount, 800);
    const handle = options.scheduler.setTimeout(() => {
      if (!isCurrentOrder(token)) {
        return;
      }

      orderWork = undefined;
      revealOrderRank();
    }, delayMs);
    orderWork = { handle, token };
  }

  function settleOrder() {
    phase = "result";
    generation += 1;
    cancelSelectionWork();
    cancelOrderWork();
    publish();
  }

  function settleSingle(scheduledGeneration: number) {
    if (generation !== scheduledGeneration || phase !== "collecting") {
      return;
    }

    const selectedParticipants = participants.slice();
    const selectionCount = settings.selectionCount;
    for (let index = 0; index < selectionCount; index += 1) {
      const remainingCount = selectedParticipants.length - index;
      const swapIndex = index + Math.floor(randomFraction() * remainingCount);
      const participant = selectedParticipants[index];
      const replacement = selectedParticipants[swapIndex];
      if (participant === undefined || replacement === undefined) {
        return;
      }
      selectedParticipants[index] = replacement;
      selectedParticipants[swapIndex] = participant;
    }

    const winners = selectedParticipants.slice(0, selectionCount);
    const winnerIds = winners.map((participant) => participant.id);
    const winnerIdSet = new Set(winnerIds);
    participants.forEach((participant) => {
      participant.state = winnerIdSet.has(participant.id)
        ? "selected"
        : "retiring";
    });

    background = averageColor(winners.map((participant) => participant.color));
    result = Object.freeze({
      kind: "single",
      selectedParticipantIds: Object.freeze(winnerIds),
      background: cloneColor(background),
    });
    phase = "result";
    generation += 1;
    cancelSelectionWork();
    playSound("chosen");
    vibrate(100);
    publish();
  }

  function settleGroup(scheduledGeneration: number) {
    if (generation !== scheduledGeneration || phase !== "collecting") {
      return;
    }

    const groupedParticipants = participants.filter(
      (participant) => participant.state === "active",
    );
    const groupCount = settings.selectionCount;
    if (groupedParticipants.length <= groupCount) {
      return;
    }

    shuffle(groupedParticipants);
    const palette = createGroupPalette(groupCount);
    const groups: Array<{
      readonly groupId: number;
      readonly participantIds: readonly string[];
      readonly color: Readonly<ChooserColor>;
    }> = [];
    const baseGroupSize = Math.floor(groupedParticipants.length / groupCount);
    const extraGroupCount = groupedParticipants.length % groupCount;
    let participantOffset = 0;

    for (let groupId = 0; groupId < groupCount; groupId += 1) {
      const groupSize = baseGroupSize + (groupId < extraGroupCount ? 1 : 0);
      const color = palette[groupId];
      if (color === undefined) {
        return;
      }

      const groupParticipants = groupedParticipants.slice(
        participantOffset,
        participantOffset + groupSize,
      );
      const participantIds = Object.freeze(
        groupParticipants.map((participant) => participant.id),
      );
      groups.push(
        Object.freeze({
          groupId,
          participantIds,
          color,
        }),
      );
      groupParticipants.forEach((participant) => {
        participant.state = "grouped";
        participant.groupId = groupId;
        participant.targetColor = color;
      });
      participantOffset += groupSize;
    }

    background = cloneColor(DEFAULT_COLOR);
    result = Object.freeze({
      kind: "group" as const,
      groups: Object.freeze(groups),
      background: cloneColor(background),
    });
    phase = "result";
    generation += 1;
    cancelSelectionWork();
    vibrate(100);
    publish();
  }

  function shuffle<T>(values: T[]) {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(randomFraction() * (index + 1));
      const value = values[index];
      const replacement = values[swapIndex];
      if (value === undefined || replacement === undefined) {
        return;
      }
      values[index] = replacement;
      values[swapIndex] = value;
    }
  }

  function createGroupPalette(groupCount: number) {
    const hueStep = 360 / groupCount;
    const initialHue = randomFraction() * hueStep;
    const palette: ChooserColor[] = [];

    for (let groupId = 0; groupId < groupCount; groupId += 1) {
      const hue = (initialHue + groupId * hueStep) % 360;
      const saturation = 0.5 + randomFraction() * 0.5;
      const value = 0.5 + randomFraction() * 0.5;
      palette.push(hsvToColor(hue, saturation, value));
    }

    shuffle(palette);
    return palette;
  }

  function isCurrentSelection(scheduledGeneration: number) {
    return (
      !destroyed &&
      phase === "collecting" &&
      generation === scheduledGeneration &&
      selectionWork?.generation === scheduledGeneration
    );
  }

  function isCurrentOrder(token: number) {
    return (
      !destroyed && phase === "order-revealing" && orderWork?.token === token
    );
  }

  function isCurrentReset(resetGeneration: number, token: number) {
    return (
      !destroyed &&
      phase === "resetting" &&
      generation === resetGeneration &&
      resetWork?.generation === resetGeneration &&
      resetWork.token === token
    );
  }

  function cancelSelectionWork() {
    if (selectionWork === undefined) {
      return;
    }

    if (selectionWork.kind === "frame") {
      options.scheduler.cancelAnimationFrame(selectionWork.handle);
    } else {
      options.scheduler.clearTimeout(selectionWork.handle);
    }
    selectionWork = undefined;
  }

  function cancelOrderWork() {
    if (orderWork !== undefined) {
      options.scheduler.clearTimeout(orderWork.handle);
      orderWork = undefined;
    }
    orderToken += 1;
  }

  function cancelResetWork() {
    if (resetWork !== undefined) {
      options.scheduler.clearTimeout(resetWork.handle);
      resetWork = undefined;
    }
    resetToken += 1;
  }

  function publish() {
    snapshot = createSnapshot();
    listeners.forEach((listener) => listener());
  }

  function createSnapshot(): ChooserSnapshot {
    const frozenParticipants = participants.map((participant) =>
      Object.freeze({
        id: participant.id,
        pointerId: participant.pointerId,
        inputFamily: participant.inputFamily,
        position: clonePosition(participant.position),
        color: cloneColor(participant.color),
        createdAtMs: participant.createdAtMs,
        state: participant.state,
        ...(participant.rank === undefined ? {} : { rank: participant.rank }),
        ...(participant.groupId === undefined
          ? {}
          : { groupId: participant.groupId }),
        ...(participant.targetColor === undefined
          ? {}
          : { targetColor: cloneColor(participant.targetColor) }),
      }),
    );

    return Object.freeze({
      phase,
      selectionMode: settings.selectionMode,
      selectionCount: settings.selectionCount,
      controlsVisible: phase === "idle",
      inputFamily,
      activeParticipantCount: activeParticipantCount(),
      participants: Object.freeze(frozenParticipants),
      result,
      background: cloneColor(background),
    });
  }

  function createOrderResult(ranks: readonly OrderRank[]): ChooserResult {
    return Object.freeze({
      kind: "order" as const,
      ranks: Object.freeze([...ranks]),
      background: cloneColor(DEFAULT_COLOR),
    });
  }

  function activeParticipantCount() {
    return participants.reduce(
      (count, participant) => count + (participant.state === "active" ? 1 : 0),
      0,
    );
  }

  function findHitSimulatedParticipant(position: Readonly<ChooserPosition>) {
    const radius = Math.max(0, settings.circleSizePercent) * 0.5 + 8;
    const hitRadiusSquared = radius * radius;
    let nearestIndex = -1;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;

    participants.forEach((participant, index) => {
      if (participant.inputFamily !== "simulated") {
        return;
      }

      const dx = participant.position.x - position.x;
      const dy = participant.position.y - position.y;
      const distanceSquared = dx * dx + dy * dy;
      if (
        distanceSquared <= hitRadiusSquared &&
        distanceSquared <= nearestDistanceSquared
      ) {
        nearestIndex = index;
        nearestDistanceSquared = distanceSquared;
      }
    });

    return nearestIndex;
  }

  function findLastSimulatedParticipantIndex() {
    for (let index = participants.length - 1; index >= 0; index -= 1) {
      if (participants[index]?.inputFamily === "simulated") {
        return index;
      }
    }
    return -1;
  }

  function randomColor(): ChooserColor {
    return {
      r: Math.round(randomFraction() * 255),
      g: Math.round(randomFraction() * 255),
      b: Math.round(randomFraction() * 255),
    };
  }

  function randomFraction() {
    try {
      const value = options.random.next();
      return Number.isFinite(value)
        ? Math.min(0.999999, Math.max(0, value))
        : 0.5;
    } catch {
      return 0.5;
    }
  }

  function playSound(cue: "chosen" | "down" | "up") {
    if (!settings.soundEnabled) {
      return;
    }

    try {
      options.effects.playSound(cue);
    } catch {
      // Feedback is best effort and must never interrupt selection semantics.
    }
  }

  function vibrate(durationMs: 40 | 100) {
    if (!settings.vibrationEnabled) {
      return;
    }

    try {
      options.effects.vibrate(durationMs);
    } catch {
      // Feedback is best effort and must never interrupt selection semantics.
    }
  }
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
  return cloneColor({
    r: Math.floor(totals.r / colors.length),
    g: Math.floor(totals.g / colors.length),
    b: Math.floor(totals.b / colors.length),
  });
}

function hsvToColor(hue: number, saturation: number, value: number) {
  const chroma = value * saturation;
  const hueSegment = hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSegment % 2) - 1));
  const match = value - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  switch (Math.floor(hueSegment)) {
    case 0:
      red = chroma;
      green = secondary;
      break;
    case 1:
      red = secondary;
      green = chroma;
      break;
    case 2:
      green = chroma;
      blue = secondary;
      break;
    case 3:
      green = secondary;
      blue = chroma;
      break;
    case 4:
      red = secondary;
      blue = chroma;
      break;
    default:
      red = chroma;
      blue = secondary;
      break;
  }

  return Object.freeze({
    r: Math.round((red + match) * 255),
    g: Math.round((green + match) * 255),
    b: Math.round((blue + match) * 255),
  });
}

function isDirectPointer(pointerType: ChooserPointerType) {
  return pointerType === "touch" || pointerType === "pen";
}

function isSimulatedPointer(pointerType: ChooserPointerType) {
  return pointerType === "mouse" || pointerType === "trackpad";
}

function modeDelay(settings: Readonly<ChooserSettings>) {
  const delay =
    settings.selectionMode === "single"
      ? settings.singleDelayMs
      : settings.selectionMode === "group"
        ? settings.groupDelayMs
        : settings.orderDelayMs;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function modeLifetime(settings: Readonly<ChooserSettings>) {
  const lifetime =
    settings.selectionMode === "single"
      ? settings.singleLifetimeMs
      : settings.selectionMode === "group"
        ? settings.groupLifetimeMs
        : settings.orderLifetimeMs;
  return Number.isFinite(lifetime) ? Math.max(0, lifetime) : 0;
}

function normalizeSettings(
  settings: Readonly<ChooserSettings>,
): Readonly<ChooserSettings> {
  const selectionMode = settings.selectionMode;
  const minimum = selectionMode === "group" ? 2 : 1;
  const requestedCount = Number.isFinite(settings.selectionCount)
    ? Math.round(settings.selectionCount)
    : minimum;
  const selectionCount =
    selectionMode === "order"
      ? 1
      : Math.max(minimum, Math.min(5, requestedCount));

  return Object.freeze({ ...settings, selectionCount });
}

function settingsEqual(
  left: Readonly<ChooserSettings>,
  right: Readonly<ChooserSettings>,
) {
  return (
    left.selectionMode === right.selectionMode &&
    left.selectionCount === right.selectionCount &&
    left.soundEnabled === right.soundEnabled &&
    left.vibrationEnabled === right.vibrationEnabled &&
    left.topPaddingPx === right.topPaddingPx &&
    left.circleSizePercent === right.circleSizePercent &&
    left.singleDelayMs === right.singleDelayMs &&
    left.groupDelayMs === right.groupDelayMs &&
    left.orderDelayMs === right.orderDelayMs &&
    left.singleLifetimeMs === right.singleLifetimeMs &&
    left.groupLifetimeMs === right.groupLifetimeMs &&
    left.orderLifetimeMs === right.orderLifetimeMs
  );
}

function clonePosition(position: Readonly<ChooserPosition> | undefined) {
  const x = position?.x ?? DEFAULT_POSITION.x;
  const y = position?.y ?? DEFAULT_POSITION.y;
  return Object.freeze({ x, y });
}

function cloneColor(color: Readonly<ChooserColor> | undefined) {
  const r = color?.r ?? DEFAULT_COLOR.r;
  const g = color?.g ?? DEFAULT_COLOR.g;
  const b = color?.b ?? DEFAULT_COLOR.b;
  return Object.freeze({ r, g, b });
}

function distance(
  first: Readonly<ChooserPosition>,
  second: Readonly<ChooserPosition>,
) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}
