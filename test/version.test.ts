import { describe, expect, it } from "vitest";

import { compareVersions, nextVersion, parseVersion } from "../src/version.js";

describe("version vYYYY.M.D[.N]", () => {
  it.each([
    ["v2026.8.9", "v2026.8.10"],
    ["v2026.9.30", "v2026.10.1"],
    ["v2026.12.31", "v2027.1.1"],
    ["v2026.8.22", "v2026.8.22.1"],
  ])("%s < %s numerically", (a, b) => {
    expect(compareVersions(a, b)).toBeLessThan(0);
    expect(compareVersions(b, a)).toBeGreaterThan(0);
  });

  it("rejects a version without the v prefix or with the wrong shape", () => {
    expect(() => parseVersion("2026.8.23")).toThrow();
    expect(() => parseVersion("v2026.8")).toThrow();
    expect(() => parseVersion("v2026.08.23a")).toThrow();
  });

  it("nextVersion: today's date, or .N bump on a same-day re-run, never a regression", () => {
    const now = new Date("2026-08-23T06:00:00Z");
    expect(nextVersion(now, null)).toBe("v2026.8.23");
    expect(nextVersion(now, "v2026.8.22")).toBe("v2026.8.23");
    expect(nextVersion(now, "v2026.8.23")).toBe("v2026.8.23.1");
    expect(nextVersion(now, "v2026.8.23.1")).toBe("v2026.8.23.2");
    expect(nextVersion(now, "v2026.8.24")).toBe("v2026.8.24.1"); // clock behind the last publisher: bump, do not regress
  });
});
