import { describe, it, expect, vi, afterEach } from "vitest";

describe("database location", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("opens the file named by DATABASE_PATH", async () => {
    vi.stubEnv("DATABASE_PATH", ":memory:");
    const { getSqlite } = await import("~/db");
    expect(getSqlite().name).toBe(":memory:");
  });
});
