// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import type {
  ChooserParticipant,
  ChooserResult,
  ChooserSnapshot,
} from "./chooser-session";

/**
 * Projects meaningful session changes into one atomic polite-live message.
 * Position-only snapshots deliberately return null so pointer motion is quiet.
 */
export function getChooserAnnouncement(
  previous: Readonly<ChooserSnapshot> | null,
  current: Readonly<ChooserSnapshot>,
): string | null {
  if (
    current.result?.kind === "order" &&
    (current.phase === "order-revealing" || current.phase === "result")
  ) {
    const orderAnnouncement = getOrderAnnouncement(
      previous,
      current,
      current.result,
    );
    if (orderAnnouncement !== null) {
      return orderAnnouncement;
    }
  }

  if (
    current.phase === "result" &&
    current.result?.kind === "single" &&
    !sameSingleResult(previous?.result ?? null, current.result)
  ) {
    const selected = current.result.selectedParticipantIds.map((id) =>
      participantOrdinal(current.participants, id),
    );
    return `Single result. Selected ${describeParticipants(selected)}.`;
  }

  if (
    current.phase === "result" &&
    current.result?.kind === "group" &&
    !sameGroupResult(previous?.result ?? null, current.result)
  ) {
    const groups = current.result.groups.map((group) => {
      const assigned = group.participantIds.map((id) =>
        participantOrdinal(current.participants, id),
      );
      return `Group ${group.groupId + 1}: ${describeParticipants(assigned)}.`;
    });
    return `Group result. ${groups.join(" ")}`;
  }

  const phaseChanged = previous?.phase !== current.phase;
  const countChanged =
    previous?.activeParticipantCount !== current.activeParticipantCount;
  if (previous !== null && !phaseChanged && !countChanged) {
    return null;
  }

  switch (current.phase) {
    case "idle":
      return `Ready. ${describeParticipantCount(current.activeParticipantCount)}.`;
    case "collecting":
      return `Collecting ${describeParticipantCount(current.activeParticipantCount)}.`;
    case "order-revealing":
      return `Revealing order. ${describeParticipantCount(current.activeParticipantCount)}.`;
    case "resetting":
      return "Clearing result.";
    case "result":
      return `Result ready. ${describeParticipantCount(current.activeParticipantCount)}.`;
  }
}

function getOrderAnnouncement(
  previous: Readonly<ChooserSnapshot> | null,
  current: Readonly<ChooserSnapshot>,
  result: Extract<ChooserResult, { readonly kind: "order" }>,
) {
  const previousRanks = continuingOrder(previous, current)
    ? previous?.result?.kind === "order"
      ? previous.result.ranks
      : []
    : [];
  if (!isRankPrefix(previousRanks, result.ranks)) {
    return null;
  }

  const messages = result.ranks.slice(previousRanks.length).map((rank) => {
    const participant = participantOrdinal(
      current.participants,
      rank.participantId,
    );
    return `Order rank ${rank.rank}: participant ${participant}.`;
  });
  const completed = current.phase === "result" && previous?.phase !== "result";
  if (completed) {
    const summary = result.ranks.map((rank) => {
      const participant = participantOrdinal(
        current.participants,
        rank.participantId,
      );
      return `Rank ${rank.rank}: participant ${participant}.`;
    });
    messages.push(`Order complete. ${summary.join(" ")}`);
  }

  return messages.length > 0 ? messages.join(" ") : null;
}

function continuingOrder(
  previous: Readonly<ChooserSnapshot> | null,
  current: Readonly<ChooserSnapshot>,
) {
  if (previous?.result?.kind !== "order") {
    return false;
  }
  if (previous.phase === "order-revealing") {
    return current.phase === "order-revealing" || current.phase === "result";
  }
  return previous.phase === "result" && current.phase === "result";
}

function isRankPrefix(
  prefix: readonly Readonly<{ participantId: string; rank: number }>[],
  ranks: readonly Readonly<{ participantId: string; rank: number }>[],
) {
  return (
    prefix.length <= ranks.length &&
    prefix.every(
      (rank, index) =>
        rank.participantId === ranks[index]?.participantId &&
        rank.rank === ranks[index]?.rank,
    )
  );
}

function sameSingleResult(
  previous: ChooserResult | null,
  current: Extract<ChooserResult, { readonly kind: "single" }>,
) {
  return (
    previous?.kind === "single" &&
    sameIds(previous.selectedParticipantIds, current.selectedParticipantIds)
  );
}

function sameGroupResult(
  previous: ChooserResult | null,
  current: Extract<ChooserResult, { readonly kind: "group" }>,
) {
  return (
    previous?.kind === "group" &&
    previous.groups.length === current.groups.length &&
    previous.groups.every((group, index) => {
      const currentGroup = current.groups[index];
      return (
        currentGroup !== undefined &&
        group.groupId === currentGroup.groupId &&
        sameIds(group.participantIds, currentGroup.participantIds)
      );
    })
  );
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function participantOrdinal(
  participants: readonly Readonly<ChooserParticipant>[],
  participantId: string,
) {
  const index = participants.findIndex(
    (participant) => participant.id === participantId,
  );
  return index >= 0 ? index + 1 : "unknown";
}

function describeParticipants(ordinals: readonly (number | "unknown")[]) {
  const values = ordinals.map(String);
  const label = values.length === 1 ? "participant" : "participants";
  return `${label} ${formatList(values)}`;
}

function describeParticipantCount(count: number) {
  return `${count} ${count === 1 ? "participant" : "participants"}`;
}

function formatList(values: readonly string[]) {
  if (values.length <= 1) {
    return values[0] ?? "unknown";
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
