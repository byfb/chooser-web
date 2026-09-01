// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

export type ChooserReleaseKind = "candidate" | "development" | "production";
export type ChooserSourceStatus = "approved" | "pending";

export interface ChooserReleaseSnapshot {
  readonly kind: ChooserReleaseKind;
  readonly revision: string | null;
  readonly sourceArchivePath: string | null;
  readonly sourceUrl: string | null;
}

interface ChooserReleaseInput {
  readonly buildIdentity: string;
  readonly sourceStatus: string;
  readonly sourceUrl: string;
}

const FULL_GIT_SHA = /^[0-9a-f]{40,64}$/u;

export function createChooserReleaseSnapshot({
  buildIdentity,
  sourceStatus,
  sourceUrl,
}: ChooserReleaseInput): ChooserReleaseSnapshot {
  if (!FULL_GIT_SHA.test(buildIdentity)) {
    return Object.freeze({
      kind: "development",
      revision: null,
      sourceArchivePath: null,
      sourceUrl: null,
    });
  }

  const sourceArchivePath = `/source/chooser-web-${buildIdentity}.tar.gz`;
  if (sourceStatus !== "approved") {
    return Object.freeze({
      kind: "candidate",
      revision: buildIdentity,
      sourceArchivePath,
      sourceUrl: null,
    });
  }

  if (!isImmutableSourceUrl(sourceUrl, buildIdentity)) {
    throw new Error(
      "An approved release requires an immutable HTTPS source URL for its exact revision",
    );
  }

  return Object.freeze({
    kind: "production",
    revision: buildIdentity,
    sourceArchivePath,
    sourceUrl,
  });
}

function isImmutableSourceUrl(value: string, revision: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.search === "" &&
      url.hash === "" &&
      value.toLowerCase().includes(revision)
    );
  } catch {
    return false;
  }
}
