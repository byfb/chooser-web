// SPDX-FileCopyrightText: 2026 byfb
// SPDX-License-Identifier: GPL-3.0-or-later

import { spawn } from "node:child_process";

const checks = [
  ["formatting", ["format:check"]],
  ["lint", ["lint"]],
  ["Astro and TypeScript", ["check"]],
  ["FSD boundaries", ["fsd:check"]],
  ["GPL and provenance", ["legal:check"]],
  ["tests and coverage", ["test:coverage"]],
  ["static build", ["build"]],
];

for (const [label, args] of checks) {
  console.log(`\n[verify] ${label}`);
  await runPnpm(args);
}

console.log("\n[verify] all checks passed");

function runPnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pnpm ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}
