import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CollectOptions, collect } from "../src/collect.ts";
import { type CursorApiOptions, fetchCursorUsagePages, loadCursorCredentials } from "../src/cursor-api.ts";
import { cursorStateDbPath } from "../src/paths.ts";
import { type ExtractState, SOURCES, type Source, type TokenEvent } from "../src/types.ts";

const dirs: string[] = [];
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-api-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const credentials = () => ({ accountId: "account-hash", cookie: "WorkosCursorSessionToken=secret" });
const until = Date.UTC(2026, 9, 2);
const row = (timestamp = until - 1000) => ({
  timestamp: String(timestamp),
  model: "claude-4.6-opus",
  kind: "Included",
  tokenUsage: { inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 },
});
const page = (rows: unknown[], total = rows.length) =>
  Response.json({
    usageEventsDisplay: rows,
    totalUsageEventsCount: total,
  });
type Handler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** A personal account: it belongs to no team. */
const fetcher = (fn: Handler) =>
  (async (input, init) =>
    String(input).endsWith("/teams") ? Response.json({ teams: [] }) : fn(input, init)) as typeof fetch;
/** Every page's events, and the account they're for. */
async function fetchCursorUsage(
  opts: CursorApiOptions,
): Promise<{ events: TokenEvent[]; accountId: string }> {
  const events: TokenEvent[] = [];
  let accountId = "";
  for await (const page of fetchCursorUsagePages(opts)) {
    events.push(...page.events);
    accountId = page.accountId;
  }
  return { events, accountId };
}
const options = { dbPath: "unused", since: 0, until, credentials, pageSize: 100 };

function database(value: string): string {
  const path = join(directory(), "state.vscdb");
  const db = new Database(path);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)").run(value);
  db.close();
  return path;
}

function jwt(subject: string): string {
  return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

describe("Cursor dashboard", () => {
  test("reads credentials from state.vscdb under CURSOR_DATA_DIR", () => {
    const prev = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = "/tmp/cursor-global";
    expect(cursorStateDbPath()).toBe("/tmp/cursor-global/state.vscdb");
    if (prev === undefined) delete process.env.CURSOR_DATA_DIR;
    else process.env.CURSOR_DATA_DIR = prev;
  });

  test("loads a read-only JWT and derives the cookie from the final subject component", () => {
    const token = jwt("provider|user_123");
    const c = loadCursorCredentials(database(token));
    expect(c.cookie).toBe(`WorkosCursorSessionToken=user_123%3A%3A${token}`);
    expect(c.accountId).toMatch(/^[a-f0-9]{64}$/);
    expect(loadCursorCredentials(database(jwt("user_123"))).accountId).toBe(c.accountId);
  });

  test("malformed credentials never appear in errors", () => {
    for (const token of ["secret-do-not-log", jwt("bad\r\nCookie: secret"), jwt("")]) {
      expect(() => loadCursorCredentials(database(token))).toThrow("Cursor credentials unavailable");
    }
    expect(() => loadCursorCredentials(join(directory(), "missing"))).toThrow(
      "Cursor credentials unavailable",
    );
  });

  test("paginates and maps actual counts without exposing credentials or content", async () => {
    const bodies: Record<string, unknown>[] = [];
    const first = Array.from({ length: 100 }, (_, i) => ({ ...row(until - i - 1), text: "private content" }));
    const r = await fetchCursorUsage({
      ...options,
      fetch: fetcher(async (url, init) => {
        expect(url).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
        expect(new Headers(init?.headers).get("Cookie")).toBe(credentials().cookie);
        expect(init?.redirect).toBe("error");
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1 ? page(first, 101) : page([row(until - 1001)], 101);
      }),
    });
    expect(bodies.map((b) => [b.page, b.pageSize, b.startDate, b.endDate])).toEqual([
      [1, 100, "0", String(until)],
      [2, 100, "0", String(until)],
    ]);
    expect(r.events).toHaveLength(101);
    expect(r.events[0]).toMatchObject({
      source: "cursor_api",
      timestamp: until - 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
    });
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("private content");
  });

  test("maps reported costs with cursorbar precedence and preserves zero and missing costs", async () => {
    const rows = [
      { ...row(), chargedCents: 0, tokenUsage: { ...row().tokenUsage, totalCents: 123 } },
      { ...row(), chargedCents: 2.75, tokenUsage: { ...row().tokenUsage, totalCents: 123 } },
      { ...row(), tokenUsage: { ...row().tokenUsage, totalCents: 4.125 } },
      row(),
    ];
    const result = await fetchCursorUsage({ ...options, fetch: fetcher(async () => page(rows)) });
    expect(result.events.map((e) => e.costCents)).toEqual([0, 2.75, 4.125, null]);
    const noCosts = await fetchCursorUsage({
      ...options,
      fetch: fetcher(async () =>
        page(
          rows.map((r) => ({
            ...r,
            chargedCents: undefined,
            tokenUsage: row().tokenUsage,
          })),
        ),
      ),
    });
    expect(result.events.map((e) => e.messageId)).toEqual(noCosts.events.map((e) => e.messageId));
  });

  test("rejects malformed reported costs", async () => {
    for (const chargedCents of [-1, "4", 100_000_001]) {
      await expect(
        fetchCursorUsage({ ...options, fetch: fetcher(async () => page([{ ...row(), chargedCents }])) }),
      ).rejects.toThrow("Invalid Cursor cost");
    }
  });

  test("maps Grok Bot dashboard rows onto grok_bot and leaves other models on cursor_api", async () => {
    const models: [string, string][] = [
      ["grok-bot-automation", "grok_bot"],
      ["grok-bot-default", "grok_bot"],
      ["grok-bot-cua", "grok_bot"],
      ["grok-bot", "grok_bot"],
      ["grok-bot-extra", "grok_bot"],
      ["grok-4.7-high", "cursor_api"],
      ["composer-2.5", "cursor_api"],
      ["not-grok-bot-automation", "cursor_api"],
    ];
    const rows = [
      ...models.map(([model]) => ({ ...row(), model })),
      { ...row(), model: "grok-bot-default", tokenUsage: null },
    ];
    const r = await fetchCursorUsage({
      ...options,
      pageSize: 1,
      fetch: fetcher(async (_url, init) => {
        const { page: number } = JSON.parse(String(init?.body));
        return page([rows[number - 1]], rows.length);
      }),
    });
    expect(r.events.map((e) => [e.model, e.source])).toEqual(models);
    expect(r.events.every((e) => e.inputTokens === 10 && e.outputTokens === 20)).toBe(true);
  });

  test("IDs survive page shifts and preserve identical rows", async () => {
    const run = (rows: unknown[]) => fetchCursorUsage({ ...options, fetch: fetcher(async () => page(rows)) });
    const a = await run([row(), row()]);
    const b = await run([row(until - 1), row(), row()]);
    expect(a.events.map((e) => e.messageId)).toEqual(b.events.slice(1).map((e) => e.messageId));
    expect(a.events[0]!.messageId).not.toBe(a.events[1]!.messageId);
  });

  test("reloads credentials once after 401, and rejects an account change", async () => {
    let loads = 0;
    let calls = 0;
    const run = (accountChanged: boolean) =>
      fetchCursorUsage({
        ...options,
        credentials: () => ({
          accountId: accountChanged && loads++ > 0 ? "other" : "same",
          cookie: String(loads++),
        }),
        fetch: fetcher(async () => (++calls % 2 === 1 ? new Response(null, { status: 401 }) : page([row()]))),
      });
    expect((await run(false)).events).toHaveLength(1);
    loads = 0;
    calls = 0;
    await expect(run(true)).rejects.toThrow("Cursor usage request failed");
  });

  test("an account change before the first page cannot reuse another account's window", async () => {
    await expect(
      fetchCursorUsage({
        ...options,
        expectedAccountId: "other",
        fetch: fetcher(async () => {
          throw new Error("must not fetch");
        }),
      }),
    ).rejects.toThrow("Cursor account changed during sync");
  });

  test("a later-page failure rejects the whole window", async () => {
    let calls = 0;
    await expect(
      fetchCursorUsage({
        ...options,
        fetch: fetcher(async () =>
          ++calls === 1
            ? page(
                Array.from({ length: 100 }, (_, i) => row(until - i - 1)),
                101,
              )
            : new Response(null, { status: 500 }),
        ),
      }),
    ).rejects.toThrow("HTTP 500");
    expect(calls).toBe(2);
  });

  test("an empty final page cannot commit a truncated window", async () => {
    let calls = 0;
    await expect(
      fetchCursorUsage({
        ...options,
        fetch: fetcher(async () =>
          ++calls === 1
            ? page(
                Array.from({ length: 100 }, (_, i) => row(until - i - 1)),
                101,
              )
            : page([], 101),
        ),
      }),
    ).rejects.toThrow("Incomplete Cursor usage response");
  });

  test("reads team-billed rows the user owns, once, keeping twins split by a page", async () => {
    const bodies: Record<string, unknown>[] = [];
    const ours = { owningUser: "42", owningTeam: 7 };
    const teamRows = [
      { ...row(), ...ours },
      { ...row(), ...ours },
      { ...row(), ...ours, model: "grok-bot-default" },
      { ...row(), owningUser: 43, owningTeam: 7, model: "teammate" },
      { ...row(), owningTeam: 7, model: "no-owner" },
      { ...row(), owningUser: 42, owningTeam: 8, model: "other-team" },
    ];
    const r = await fetchCursorUsage({
      ...options,
      pageSize: 1,
      fetch: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (url.endsWith("/teams")) return Response.json({ teams: [{ id: 7 }, { id: "7" }] });
        if (url.endsWith("/team")) return Response.json({ userId: 42 });
        // The personal call already has the first copy of the row.
        if (!body.teamId) return page([row()]);
        return page([teamRows[body.page - 1]], teamRows.length);
      }) as typeof fetch,
    });
    expect(r.events.map((e) => [e.model, e.source])).toEqual([
      ["claude-4.6-opus", "cursor_api"],
      ["claude-4.6-opus", "cursor_api"],
      ["grok-bot-default", "grok_bot"],
    ]);
    expect(new Set(r.events.map((e) => e.messageId)).size).toBe(3);
    expect(bodies.filter((b) => b.teamId).every((b) => b.teamId === 7)).toBe(true);
    expect(bodies.filter((b) => b.page && b.teamId).every((b) => b.userId === 42)).toBe(true);
  });

  test("counts a team Grok Bot row whose model is empty", async () => {
    const ours = { owningUser: "42", owningTeam: 7 };
    const grokUsage = {
      inputTokens: 40_000,
      outputTokens: 21_800,
      cacheWriteTokens: 100,
      cacheReadTokens: 50,
    };
    const teamRows = [
      // Dashboard: Product "Grok Bot", Usage Type "Included", Model "-", Cost "-".
      {
        ...row(until - 2000),
        ...ours,
        model: "",
        clientType: "Grok Bot",
        kind: "Included",
        tokenUsage: grokUsage,
      },
      { ...row(until - 3000), ...ours, model: null, product: "grok-bot", tokenUsage: grokUsage },
      {
        ...row(until - 4000),
        ...ours,
        model: "  ",
        clientType: "sand",
        tokenUsage: { inputTokens: 5, outputTokens: 0 },
      },
      { ...row(until - 4500), ...ours, model: "", client_type: "grok_bot", tokenUsage: grokUsage },
      { ...row(until - 5000), owningUser: 43, owningTeam: 7, model: "", clientType: "grok-bot" },
      { ...row(until - 6000), ...ours, model: "composer-2.5" },
      { ...row(until - 7000), ...ours, model: "" },
    ];
    const r = await fetchCursorUsage({
      ...options,
      fetch: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (url.endsWith("/teams")) return Response.json({ teams: [{ id: 7 }] });
        if (url.endsWith("/team")) return Response.json({ userId: 42 });
        if (!body.teamId) return page([row()]);
        return page(teamRows);
      }) as typeof fetch,
    });
    const tokens = (event: TokenEvent) =>
      event.inputTokens + event.outputTokens + event.cacheCreationTokens + event.cacheReadTokens;
    const grok = r.events.filter((event) => event.source === "grok_bot");
    expect(grok.map((event) => [event.model, tokens(event)])).toEqual([
      ["grok-bot", 61_950],
      ["grok-bot", 61_950],
      ["grok-bot", 5],
      ["grok-bot", 61_950],
    ]);
    expect(grok.every((event) => event.costCents == null)).toBe(true);
    expect(r.events.filter((event) => event.source === "cursor_api").map((event) => event.model)).toEqual([
      "claude-4.6-opus",
      "composer-2.5",
    ]);
  });

  test("a failed team read keeps personal rows but never finishes the window", async () => {
    const pages: { events: number; done: boolean }[] = [];
    await expect(
      (async () => {
        for await (const p of fetchCursorUsagePages({
          ...options,
          fetch: (async (url: string) =>
            url.endsWith("/teams") ? new Response(null, { status: 500 }) : page([row()])) as typeof fetch,
        }))
          pages.push({ events: p.events.length, done: p.done });
      })(),
    ).rejects.toThrow("HTTP 500");
    expect(pages).toEqual([{ events: 1, done: false }]);
  });

  test("does not fabricate tokens for requests without a breakdown", async () => {
    const r = await fetchCursorUsage({
      ...options,
      fetch: fetcher(async () =>
        page([{ ...row(), tokenUsage: null }, { ...row(), tokenUsage: undefined }, row()]),
      ),
    });
    expect(r.events).toHaveLength(1);
  });

  test("rejects incomplete pages, malformed counts, HTTP and transport failures safely", async () => {
    for (const response of [
      page([], 101),
      Response.json({}),
      page([{ ...row(), tokenUsage: { inputTokens: -1 } }]),
      page([{ ...row(), timestamp: "invalid" }]),
      new Response("credential secret", { status: 403 }),
      new Response("credential secret"),
    ]) {
      await expect(fetchCursorUsage({ ...options, fetch: fetcher(async () => response) })).rejects.toThrow();
    }
    await expect(
      fetchCursorUsage({
        ...options,
        fetch: fetcher(async () => {
          throw new Error("secret");
        }),
      }),
    ).rejects.toThrow("Cursor usage request failed");
  });
});

describe("collect from the Cursor dashboard", () => {
  const enabled = new Set<Source>(["cursor_api"]);
  /** Store every batch with `store`, committing it only once that succeeds, as callers should. */
  async function drain(state: ExtractState, opts: CollectOptions, store = async (_: TokenEvent[]) => {}) {
    const events: TokenEvent[] = [];
    for await (const batch of collect(state, { sources: [], cursorCredentials: credentials, ...opts })) {
      await store(batch.events);
      events.push(...batch.events);
      state = batch.commit(state);
    }
    return { events, state };
  }

  test("checks every 15 minutes, overlaps seven days, and backfills a new account", async () => {
    const requests: Record<string, unknown>[] = [];
    let accountId = "first";
    const opts = {
      enabled,
      cursorCredentials: () => ({ ...credentials(), accountId }),
      cursorFetch: fetcher(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return page([row()]);
      }),
    };
    let { state } = await drain({ files: {} }, { ...opts, now: () => until });
    expect(state.cursorApi).toEqual({ accountId: "first", checkedAt: until });
    state = (await drain(state, { ...opts, now: () => until + 60_000 })).state;
    expect(requests).toHaveLength(1);
    state = (await drain(state, { ...opts, now: () => until + 15 * 60_000 })).state;
    expect(requests[1]!.startDate).toBe(String(until - 7 * 24 * 60 * 60_000));
    accountId = "second";
    await drain(state, { ...opts, now: () => until + 30 * 60_000 });
    expect(requests[2]!.startDate).toBe("0");
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  test("a failed page or store never advances the checkpoint, and the replay keeps its ids", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row(until - i - 1));
    let failSecondPage = true;
    const opts = {
      enabled,
      now: () => until,
      onError: () => {},
      cursorFetch: fetcher(async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.page === 2 && failSecondPage) return new Response(null, { status: 500 });
        const offset = (request.page - 1) * request.pageSize;
        return page(rows.slice(offset, offset + request.pageSize), rows.length);
      }),
    };
    const first = await drain({ files: {} }, opts);
    expect(first.events).toHaveLength(1000);
    expect(first.state.cursorApi).toBeUndefined();

    failSecondPage = false;
    let stores = 0;
    const offline = async () => {
      if (++stores === 2) throw new Error("offline");
    };
    await expect(drain(first.state, opts, offline)).rejects.toThrow("offline");

    const second = await drain(first.state, opts);
    expect(second.events).toHaveLength(1001);
    expect(second.events.slice(0, 1000).map((e) => e.messageId)).toEqual(
      first.events.map((e) => e.messageId),
    );
    expect(second.state.cursorApi?.checkedAt).toBe(until);
  });

  test("Grok Bot rows come only when grok_bot is enabled, which reads the dashboard alone", async () => {
    const opts = {
      now: () => until,
      cursorFetch: fetcher(async () => page([row(), { ...row(), model: "grok-bot-default" }])),
    };
    const sources = async (on: Source[]) =>
      (await drain({ files: {} }, { ...opts, enabled: new Set(on) })).events.map((e) => e.source);
    expect(await sources(["cursor_api"])).toEqual(["cursor_api"]);
    expect(await sources(["grok_bot"])).toEqual(["grok_bot"]);
    expect(await sources(["cursor_api", "grok_bot"])).toEqual(["cursor_api", "grok_bot"]);
  });

  test("never loads credentials or asks Cursor unless a dashboard source is enabled", async () => {
    for (const on of [new Set<Source>(), new Set(SOURCES)]) {
      await drain(
        { files: {} },
        {
          enabled: on,
          cursorDbPath: join(directory(), "missing.vscdb"),
          cursorCredentials: () => {
            throw new Error("must not read");
          },
          cursorFetch: fetcher(async () => {
            throw new Error("must not fetch");
          }),
          onError: (err) => {
            throw err;
          },
        },
      );
    }
  });
});
