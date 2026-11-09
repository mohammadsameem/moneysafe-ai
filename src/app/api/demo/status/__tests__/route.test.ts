import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();
vi.mock("@/db/client", () => ({ getSql: () => sqlMock }));

import { GET } from "../route";

describe("GET /api/demo/status", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    delete process.env.DEMO_MODE;
  });

  it("runs SELECT 1 and returns { demoMode, db: 'ok' } with HTTP 200", async () => {
    sqlMock.mockResolvedValueOnce([{ "?column?": 1 }]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ demoMode: false, db: "ok" });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    // tagged-template call: first argument is the strings array of the SQL
    expect(String((sqlMock.mock.calls[0]?.[0] as string[])[0])).toMatch(/SELECT 1/i);
  });

  it("reports demoMode from DEMO_MODE", async () => {
    process.env.DEMO_MODE = "true";
    sqlMock.mockResolvedValueOnce([]);
    expect(await (await GET()).json()).toEqual({ demoMode: true, db: "ok" });
  });

  it("returns { db: 'error' } with HTTP 503 when the database is down, with no error detail", async () => {
    sqlMock.mockRejectedValueOnce(new Error("password authentication failed for user postgres.SECRETREF"));

    const res = await GET();
    const text = JSON.stringify(await res.json());

    expect(res.status).toBe(503);
    expect(text).toBe('{"demoMode":false,"db":"error"}');
    expect(text).not.toContain("SECRETREF");
  });
});
