// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { getChooserAnnouncement } from "./chooser-announcement";
import type {
  ChooserParticipant,
  ChooserResult,
  ChooserSnapshot,
} from "./chooser-session";

describe("Chooser live announcements", () => {
  it("announces initial and participant-count phase changes", () => {
    const idle = createSnapshot();
    const collecting = createSnapshot({
      activeParticipantCount: 1,
      controlsVisible: false,
      inputFamily: "simulated",
      participants: [participant("simulated:1")],
      phase: "collecting",
    });

    expect(getChooserAnnouncement(null, idle)).toBe("Ready. 0 participants.");
    expect(getChooserAnnouncement(idle, collecting)).toBe(
      "Collecting 1 participant.",
    );
  });

  it("does not announce pointer movement or unchanged snapshots", () => {
    const previous = createSnapshot({
      activeParticipantCount: 1,
      controlsVisible: false,
      inputFamily: "direct",
      participants: [participant("direct:7")],
      phase: "collecting",
    });
    const moved = createSnapshot({
      ...previous,
      participants: [participant("direct:7", { position: { x: 240, y: 300 } })],
    });

    expect(getChooserAnnouncement(previous, moved)).toBeNull();
    expect(getChooserAnnouncement(previous, previous)).toBeNull();
  });

  it("announces selected participant ordinals for completed Single results", () => {
    const participants = [
      participant("simulated:1", { state: "selected" }),
      participant("simulated:2", { state: "retiring" }),
      participant("simulated:3", { state: "selected" }),
    ];
    const result: ChooserResult = {
      kind: "single",
      selectedParticipantIds: ["simulated:1", "simulated:3"],
      background: { r: 20, g: 30, b: 40 },
    };
    const settled = createSnapshot({
      activeParticipantCount: 2,
      controlsVisible: false,
      inputFamily: "simulated",
      participants,
      phase: "result",
      result,
    });

    expect(getChooserAnnouncement(createSnapshot(), settled)).toBe(
      "Single result. Selected participants 1 and 3.",
    );
  });

  it("announces every balanced Group assignment", () => {
    const participants = [
      participant("simulated:1", { groupId: 0, state: "grouped" }),
      participant("simulated:2", { groupId: 1, state: "grouped" }),
      participant("simulated:3", { groupId: 0, state: "grouped" }),
    ];
    const result: ChooserResult = {
      kind: "group",
      groups: [
        {
          groupId: 0,
          participantIds: ["simulated:1", "simulated:3"],
          color: { r: 255, g: 0, b: 0 },
        },
        {
          groupId: 1,
          participantIds: ["simulated:2"],
          color: { r: 0, g: 0, b: 255 },
        },
      ],
      background: { r: 0, g: 0, b: 0 },
    };
    const settled = createSnapshot({
      activeParticipantCount: 3,
      controlsVisible: false,
      inputFamily: "simulated",
      participants,
      phase: "result",
      result,
    });

    expect(getChooserAnnouncement(createSnapshot(), settled)).toBe(
      "Group result. Group 1: participants 1 and 3. Group 2: participant 2.",
    );
  });

  it("announces Order ranks once, in order, and includes the completed result", () => {
    const participants = [
      participant("simulated:1", { rank: 2, state: "ranked" }),
      participant("simulated:2", { rank: 1, state: "ranked" }),
    ];
    const first = createSnapshot({
      activeParticipantCount: 2,
      controlsVisible: false,
      inputFamily: "simulated",
      participants: [
        participant("simulated:1"),
        participant("simulated:2", { rank: 1, state: "ranked" }),
      ],
      phase: "order-revealing",
      result: {
        kind: "order",
        ranks: [{ participantId: "simulated:2", rank: 1 }],
        background: { r: 0, g: 0, b: 0 },
      },
      selectionMode: "order",
    });
    const complete = createSnapshot({
      activeParticipantCount: 2,
      controlsVisible: false,
      inputFamily: "simulated",
      participants,
      phase: "result",
      result: {
        kind: "order",
        ranks: [
          { participantId: "simulated:2", rank: 1 },
          { participantId: "simulated:1", rank: 2 },
        ],
        background: { r: 0, g: 0, b: 0 },
      },
      selectionMode: "order",
    });

    expect(getChooserAnnouncement(createSnapshot(), first)).toBe(
      "Order rank 1: participant 2.",
    );
    expect(getChooserAnnouncement(first, first)).toBeNull();
    expect(getChooserAnnouncement(first, complete)).toBe(
      "Order rank 2: participant 1. Order complete. Rank 1: participant 2. Rank 2: participant 1.",
    );
  });

  it("announces Order completion without replaying an existing final rank", () => {
    const revealing = createSnapshot({
      activeParticipantCount: 1,
      controlsVisible: false,
      inputFamily: "direct",
      participants: [participant("direct:4", { rank: 1, state: "ranked" })],
      phase: "order-revealing",
      result: {
        kind: "order",
        ranks: [{ participantId: "direct:4", rank: 1 }],
        background: { r: 0, g: 0, b: 0 },
      },
      selectionMode: "order",
    });
    const complete = createSnapshot({ ...revealing, phase: "result" });

    expect(getChooserAnnouncement(revealing, complete)).toBe(
      "Order complete. Rank 1: participant 1.",
    );
  });

  it("ignores regressive Order snapshots and announces reset exactly once", () => {
    const twoRanks = createOrderSnapshot(2);
    const staleOneRank = createOrderSnapshot(1);
    const resetting = createSnapshot({
      ...twoRanks,
      controlsVisible: false,
      phase: "resetting",
    });

    expect(getChooserAnnouncement(twoRanks, staleOneRank)).toBeNull();
    expect(getChooserAnnouncement(twoRanks, resetting)).toBe(
      "Clearing result.",
    );
    expect(getChooserAnnouncement(resetting, resetting)).toBeNull();
  });
});

function createOrderSnapshot(rankCount: number): ChooserSnapshot {
  const participants = [
    participant("simulated:1", {
      ...(rankCount >= 1 ? { rank: 1, state: "ranked" as const } : {}),
    }),
    participant("simulated:2", {
      ...(rankCount >= 2 ? { rank: 2, state: "ranked" as const } : {}),
    }),
  ];
  return createSnapshot({
    activeParticipantCount: 2,
    controlsVisible: false,
    inputFamily: "simulated",
    participants,
    phase: "order-revealing",
    result: {
      kind: "order",
      ranks: participants.slice(0, rankCount).map((candidate, index) => ({
        participantId: candidate.id,
        rank: index + 1,
      })),
      background: { r: 0, g: 0, b: 0 },
    },
    selectionMode: "order",
  });
}

function createSnapshot(
  overrides: Partial<ChooserSnapshot> = {},
): ChooserSnapshot {
  return {
    activeParticipantCount: 0,
    background: { r: 0, g: 0, b: 0 },
    controlsVisible: true,
    inputFamily: null,
    participants: [],
    phase: "idle",
    result: null,
    selectionCount: 1,
    selectionMode: "single",
    ...overrides,
  };
}

function participant(
  id: string,
  overrides: Partial<ChooserParticipant> = {},
): ChooserParticipant {
  return {
    color: { r: 255, g: 255, b: 255 },
    createdAtMs: 0,
    id,
    inputFamily: id.startsWith("direct:") ? "direct" : "simulated",
    pointerId: id.startsWith("direct:") ? Number(id.split(":")[1]) : undefined,
    position: { x: 100, y: 100 },
    state: "active",
    ...overrides,
  };
}
