import { describe, expect, it } from "vitest";
import {
  cacheKey,
  connectionsUrl,
  createTransportClient,
  pickJourney,
  roundUpTo5Min,
  searchStations,
} from "../src/transport";

const NOW = Date.parse("2026-05-16T15:00:00+02:00");

function connection(dep: string, arr: string, transfers = 0, categories = ["R"]) {
  return {
    from: { departure: dep },
    to: { arrival: arr },
    transfers,
    sections: categories.map((category) => ({ journey: { category } })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("cache keys", () => {
  it("rounds the departure up to the next 5 minutes", () => {
    const t = Date.parse("2026-05-16T15:01:30+02:00");
    expect(roundUpTo5Min(t)).toBe(Date.parse("2026-05-16T15:05:00+02:00"));
    expect(roundUpTo5Min(Date.parse("2026-05-16T15:05:00+02:00"))).toBe(
      Date.parse("2026-05-16T15:05:00+02:00"),
    );
  });

  it("collapses departures inside the same 5-minute bucket", () => {
    const a = cacheKey(1, 2, Date.parse("2026-05-16T15:01:00+02:00"));
    const b = cacheKey(1, 2, Date.parse("2026-05-16T15:04:59+02:00"));
    const c = cacheKey(1, 2, Date.parse("2026-05-16T15:06:00+02:00"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates departure and arrival lookups", () => {
    expect(cacheKey(1, 2, NOW, false)).not.toBe(cacheKey(1, 2, NOW, true));
  });
});

describe("connectionsUrl", () => {
  it("asks for two departures by default", () => {
    const url = connectionsUrl("https://x/v1", 8507000, 8500010, NOW, false);
    expect(url).toContain("from=8507000");
    expect(url).toContain("to=8500010");
    expect(url).toContain("limit=2");
    expect(url).not.toContain("isArrivalTime");
    expect(url).toContain("fields%5B%5D=connections%2Ftransfers");
  });

  it("asks for four arrivals in home-by mode", () => {
    const url = connectionsUrl("https://x/v1", 1, 2, NOW, true);
    expect(url).toContain("isArrivalTime=1");
    expect(url).toContain("limit=4");
  });
});

describe("pickJourney", () => {
  it("takes the first departure at or after the requested time", () => {
    const body = {
      connections: [
        connection("2026-05-16T15:20:00+0200", "2026-05-16T16:30:00+0200", 1, ["B", "IC"]),
        connection("2026-05-16T15:50:00+0200", "2026-05-16T16:55:00+0200"),
      ],
    };
    const j = pickJourney(body, NOW, false, NOW)!;
    expect(j.dep).toBe(Date.parse("2026-05-16T15:20:00+02:00"));
    expect(j.transfers).toBe(1);
    expect(j.categories).toEqual(["B", "IC"]);
    expect(j.stale).toBe(false);
  });

  it("takes the latest departure that still arrives by the target", () => {
    const target = Date.parse("2026-05-16T19:00:00+02:00");
    const body = {
      connections: [
        connection("2026-05-16T17:00:00+0200", "2026-05-16T18:10:00+0200"),
        connection("2026-05-16T17:40:00+0200", "2026-05-16T18:55:00+0200"),
        connection("2026-05-16T18:10:00+0200", "2026-05-16T19:20:00+0200"),
      ],
    };
    const j = pickJourney(body, target, true, NOW)!;
    expect(j.dep).toBe(Date.parse("2026-05-16T17:40:00+02:00"));
  });

  it("returns null when the API reports no connections", () => {
    expect(pickJourney({ connections: [] }, NOW, false, NOW)).toBeNull();
  });
});

describe("transport client", () => {
  const okBody = {
    connections: [connection("2026-05-16T15:20:00+0200", "2026-05-16T16:30:00+0200")],
  };

  function clientWith(handler: (url: string) => Response) {
    const calls: string[] = [];
    const client = createTransportClient({
      homeId: 8500010,
      baseUrl: "https://x/v1",
      now: () => NOW,
      sleep: () => Promise.resolve(),
      fetchImpl: ((url: string) => {
        calls.push(url);
        return Promise.resolve(handler(url));
      }) as unknown as typeof fetch,
    });
    return { client, calls };
  }

  it("serves a second lookup in the same bucket from the cache", async () => {
    const { client, calls } = clientWith(() => jsonResponse(okBody));
    await client.route([{ stopId: 1, when: NOW + 60_000 }]);
    await client.route([{ stopId: 1, when: NOW + 180_000 }]);
    expect(calls).toHaveLength(1);
  });

  it("reports an empty connection list as no service", async () => {
    const { client } = clientWith(() => jsonResponse({ connections: [] }));
    const out = await client.route([{ stopId: 1, when: NOW }]);
    expect(out.get(1)).toEqual({ journey: null, noService: true, error: false });
  });

  it("backs off for 30 s after a 429 and returns the last good result as stale", async () => {
    let status = 200;
    const { client, calls } = clientWith(() =>
      status === 200 ? jsonResponse(okBody) : jsonResponse({}, 429),
    );
    await client.route([{ stopId: 1, when: NOW }]);
    status = 429;
    const hit = await client.route([{ stopId: 1, when: NOW + 10 * 60_000 }]);
    expect(hit.get(1)!.error).toBe(true);
    expect(hit.get(1)!.journey!.stale).toBe(true);
    expect(client.isStale()).toBe(true);
    expect(client.backoffUntil()).toBe(NOW + 30_000);

    const before = calls.length;
    await client.route([{ stopId: 1, when: NOW + 20 * 60_000 }]);
    expect(calls).toHaveLength(before); // suppressed while backing off
  });

  it("keeps the last good result when a fetch throws", async () => {
    let fail = false;
    const { client } = clientWith(() => {
      if (fail) throw new Error("offline");
      return jsonResponse(okBody);
    });
    await client.route([{ stopId: 1, when: NOW }]);
    fail = true;
    const out = await client.route([{ stopId: 1, when: NOW + 10 * 60_000 }]);
    expect(out.get(1)!.journey!.stale).toBe(true);
    expect(client.lastGood(1)!.dep).toBe(Date.parse("2026-05-16T15:20:00+02:00"));
  });

  it("never runs more than two requests at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const client = createTransportClient({
      homeId: 2,
      baseUrl: "https://x/v1",
      now: () => NOW,
      sleep: () => Promise.resolve(),
      fetchImpl: (() => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(jsonResponse(okBody));
          }, 1);
        });
      }) as unknown as typeof fetch,
    });
    await client.route([1, 2, 3, 4, 5, 6].map((stopId) => ({ stopId, when: NOW })));
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("searchStations", () => {
  it("drops fuzzy address hits that have no id", async () => {
    const body = {
      stations: [
        { id: "8507000", name: "Bern", coordinate: { x: 46.9489, y: 7.4392 } },
        { id: null, name: "Bern, Bahnhofplatz 1", coordinate: { x: 46.9, y: 7.4 } },
      ],
    };
    const hits = await searchStations("bern", {
      baseUrl: "https://x/v1",
      fetchImpl: (() => Promise.resolve(jsonResponse(body))) as unknown as typeof fetch,
    });
    expect(hits).toEqual([{ id: 8507000, name: "Bern", lat: 46.9489, lon: 7.4392 }]);
  });
});
