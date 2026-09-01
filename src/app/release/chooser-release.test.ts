// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { createChooserReleaseSnapshot } from "./chooser-release";

const SHA = "a".repeat(40);

describe("Chooser release snapshot", () => {
  it("describes an ordinary development build without claiming a release", () => {
    expect(
      createChooserReleaseSnapshot({
        buildIdentity: "development",
        sourceStatus: "pending",
        sourceUrl: "",
      }),
    ).toEqual({
      kind: "development",
      revision: null,
      sourceArchivePath: null,
      sourceUrl: null,
    });
  });

  it("describes a clean local candidate without claiming public source", () => {
    expect(
      createChooserReleaseSnapshot({
        buildIdentity: SHA,
        sourceStatus: "pending",
        sourceUrl: "",
      }),
    ).toEqual({
      kind: "candidate",
      revision: SHA,
      sourceArchivePath: `/source/chooser-web-${SHA}.tar.gz`,
      sourceUrl: null,
    });
  });

  it("accepts only an immutable HTTPS production source for the exact SHA", () => {
    const sourceUrl = `https://chooser.example/source/chooser-web-${SHA}.tar.gz`;

    expect(
      createChooserReleaseSnapshot({
        buildIdentity: SHA,
        sourceStatus: "approved",
        sourceUrl,
      }),
    ).toEqual({
      kind: "production",
      revision: SHA,
      sourceArchivePath: `/source/chooser-web-${SHA}.tar.gz`,
      sourceUrl,
    });

    expect(() =>
      createChooserReleaseSnapshot({
        buildIdentity: SHA,
        sourceStatus: "approved",
        sourceUrl: "http://chooser.example/source/latest.tar.gz",
      }),
    ).toThrow(/immutable HTTPS/i);
  });
});
