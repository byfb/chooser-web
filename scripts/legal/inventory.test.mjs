// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";

import { assertInventoryCurrent } from "./inventory.mjs";

const reviewedInventory = {
  schemaVersion: 1,
  lockfileSha256: "reviewed-lockfile",
  shipped: [
    {
      name: "react",
      version: "19.2.8",
      license: "MIT",
      source: "https://www.npmjs.com/package/react/v/19.2.8",
    },
  ],
  buildOnly: [
    {
      name: "astro",
      version: "7.2.10",
      license: "MIT",
      source: "https://www.npmjs.com/package/astro/v/7.2.10",
    },
  ],
};

describe("reviewed dependency inventory", () => {
  it("accepts the reviewed lockfile and browser-shipped package set", () => {
    expect(() =>
      assertInventoryCurrent({
        actualLockfileSha256: "reviewed-lockfile",
        actualLockPackageIds: ["astro@7.2.10", "react@19.2.8"],
        actualShippedPackages: [
          { name: "react", version: "19.2.8", license: "MIT" },
        ],
        reviewedInventory,
      }),
    ).not.toThrow();
  });

  it("rejects an unreviewed browser-shipped package change", () => {
    expect(() =>
      assertInventoryCurrent({
        actualLockfileSha256: "reviewed-lockfile",
        actualLockPackageIds: ["astro@7.2.10", "react@19.2.8"],
        actualShippedPackages: [
          { name: "astro", version: "7.2.10", license: "MIT" },
          { name: "react", version: "19.2.8", license: "MIT" },
        ],
        reviewedInventory,
      }),
    ).toThrow(/dependency inventory is stale/i);
  });
});
