/**
 * version.ts
 *
 * The gateway's own package.json, read once: what it reports itself as.
 */
import { readFileSync } from "node:fs";

export const pkg: { name: string; version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);
