import { NextResponse } from "next/server";
import { normalizeAvinorXml, type FlightDirection } from "@/lib/avinor";
import { XMLParser } from "fast-xml-parser";

export const dynamic = "force-dynamic";

type EnrichedFlight = ReturnType<typeof normalizeAvinorXml>["flights"][number] & {
  airportName?: string;
  airlineName?: string;
  statusTextNo?: string;
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

const cacheTtlMs = 1000 * 60 * 60; // 1 hour
const upstreamTimeoutMs = 8000;
const upstreamRetryCount = 1;
const routeMinRefreshMs = 60_000;

const airportNameCache = new Map<string, { name: string; fetchedAtMs: number }>();
const airlineNameCache = new Map<string, { name: string; fetchedAtMs: number }>();

let statusTextByCodeCache:
  | { fetchedAtMs: number; byCode: Record<string, string> }
  | undefined;

type FlightsRoutePayload = ReturnType<typeof normalizeAvinorXml> & {
  feedUrl: string;
  airport: string;
  direction: FlightDirection | "BOTH";
  timeFrom: number;
  timeTo: number;
  flights: EnrichedFlight[];
};
type CacheStatus = "fresh" | "cached";

type FlightsRouteCacheEntry = {
  fetchedAtMs: number;
  payload: FlightsRoutePayload;
};

const routeCache = new Map<string, FlightsRouteCacheEntry>();
const routeInFlight = new Map<string, Promise<FlightsRoutePayload>>();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeoutRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= upstreamRetryCount; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      lastErr = e;
      if (attempt < upstreamRetryCount) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("UPSTREAM_FETCH_FAILED");
}

async function getStatusTextNoByCode(codes: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  if (statusTextByCodeCache && now - statusTextByCodeCache.fetchedAtMs < cacheTtlMs) {
    const cached = statusTextByCodeCache.byCode;
    const missing = codes.filter((c) => !cached[c]);
    if (missing.length === 0) return cached;
  }

  const resByCode: Record<string, string> = {};
  await Promise.all(
    codes.map(async (code) => {
      // Skip empty codes.
      if (!code) return;

      try {
        const res = await fetchWithTimeoutRetry(`https://asrv.avinor.no/flightStatuses/v1.0?code=${encodeURIComponent(code)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const xmlText = await res.text();
        const parsed = xmlParser.parse(xmlText) as unknown;
        const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
        const flightStatus = parsedRecord?.flightStatus && typeof parsedRecord.flightStatus === "object" ? (parsedRecord.flightStatus as Record<string, unknown>) : undefined;
        const statusTextNo =
          typeof flightStatus?.["@_statusTextNo"] === "string" ? (flightStatus?.["@_statusTextNo"] as string) : undefined;
        if (statusTextNo) resByCode[code] = statusTextNo;
      } catch {
        // Ignore status fetch failures; we'll fallback to local mapping.
      }
    }),
  );

  statusTextByCodeCache = {
    fetchedAtMs: now,
    byCode: {
      ...(statusTextByCodeCache?.byCode ?? {}),
      ...resByCode,
    },
  };

  return statusTextByCodeCache.byCode;
}

async function extractAirportNameFromXml(xmlText: string, targetCode: string): Promise<string | undefined> {
  const parsed = xmlParser.parse(xmlText) as unknown;
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const airportNames =
    parsedRecord?.airportNames && typeof parsedRecord.airportNames === "object"
      ? (parsedRecord.airportNames as Record<string, unknown>)
      : undefined;
  const entries = airportNames?.airportName;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

  for (const e of list) {
    const rec = e && typeof e === "object" ? (e as Record<string, unknown>) : undefined;
    const code = typeof rec?.["@_code"] === "string" ? (rec?.["@_code"] as string) : undefined;
    const name = typeof rec?.["@_name"] === "string" ? (rec?.["@_name"] as string) : undefined;
    if (code === targetCode && name) return name;
  }

  return undefined;
}

async function extractAirlineNameFromXml(xmlText: string, targetCode: string): Promise<string | undefined> {
  const parsed = xmlParser.parse(xmlText) as unknown;
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  const airlineNames =
    parsedRecord?.airlineNames && typeof parsedRecord.airlineNames === "object"
      ? (parsedRecord.airlineNames as Record<string, unknown>)
      : undefined;
  const entries = airlineNames?.airlineName;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];

  for (const e of list) {
    const rec = e && typeof e === "object" ? (e as Record<string, unknown>) : undefined;
    const code = typeof rec?.["@_code"] === "string" ? (rec?.["@_code"] as string) : undefined;
    const name = typeof rec?.["@_name"] === "string" ? (rec?.["@_name"] as string) : undefined;
    if (code === targetCode && name) return name;
  }

  return undefined;
}

async function getAirportNameByCode(code: string): Promise<string | undefined> {
  const cached = airportNameCache.get(code);
  if (cached && Date.now() - cached.fetchedAtMs < cacheTtlMs) return cached.name;

  const url = new URL("https://asrv.avinor.no/airportNames/v1.0");
  url.searchParams.set("airport", code);
  const res = await fetchWithTimeoutRetry(url.toString(), { cache: "no-store" });
  if (!res.ok) return undefined;

  const xmlText = await res.text();
  const name = await extractAirportNameFromXml(xmlText, code);
  if (!name) return undefined;

  airportNameCache.set(code, { name, fetchedAtMs: Date.now() });
  return name;
}

async function getAirlineNameByCode(code: string): Promise<string | undefined> {
  const cached = airlineNameCache.get(code);
  if (cached && Date.now() - cached.fetchedAtMs < cacheTtlMs) return cached.name;

  const url = new URL("https://asrv.avinor.no/airlineNames/v1.0");
  url.searchParams.set("airline", code);
  const res = await fetchWithTimeoutRetry(url.toString(), { cache: "no-store" });
  if (!res.ok) return undefined;

  const xmlText = await res.text();
  const name = await extractAirlineNameFromXml(xmlText, code);
  if (!name) return undefined;

  airlineNameCache.set(code, { name, fetchedAtMs: Date.now() });
  return name;
}

function parseDirection(value: string | null): FlightDirection | undefined {
  if (!value) return undefined;
  const v = value.toUpperCase();
  if (v === "A" || v === "D") return v;
  return undefined;
}

function parseHours(value: string | null, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(48, Math.floor(n)));
}

function parseAirport(value: string | null): string {
  const v = (value ?? "").toUpperCase();
  if (v === "SVG" || v === "BGO" || v === "OSL" || v === "TRD") return v;
  return "SVG";
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0, s-maxage=0, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

function withCacheStatus(payload: FlightsRoutePayload, cacheStatus: CacheStatus): FlightsRoutePayload & { cacheStatus: CacheStatus } {
  return { ...payload, cacheStatus };
}

async function buildFlightsPayload(
  airport: string,
  direction: FlightDirection | undefined,
  timeFrom: number,
  timeTo: number,
): Promise<FlightsRoutePayload> {
  const feedUrl = new URL("https://asrv.avinor.no/XmlFeed/v1.0");
  feedUrl.searchParams.set("airport", airport);
  feedUrl.searchParams.set("TimeFrom", String(timeFrom));
  feedUrl.searchParams.set("TimeTo", String(timeTo));
  if (direction) feedUrl.searchParams.set("direction", direction);

  const res = await fetchWithTimeoutRetry(feedUrl.toString(), {
    cache: "no-store",
    headers: { Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" },
  });

  if (!res.ok) {
    throw new Error("UPSTREAM_FEED_FAILED");
  }

  const xml = await res.text();
  const parsed = normalizeAvinorXml(xml);

  const airportCodes = Array.from(new Set(parsed.flights.map((f) => f.airport).filter((x) => Boolean(x)))) as string[];
  const airlineCodes = Array.from(new Set(parsed.flights.map((f) => f.airline).filter((x) => Boolean(x)))) as string[];

  const airportNameByCode: Record<string, string> = {};
  await Promise.all(
    airportCodes.map(async (code) => {
      const name = await getAirportNameByCode(code);
      if (name) airportNameByCode[code] = name;
    }),
  );

  const airlineNameByCode: Record<string, string> = {};
  await Promise.all(
    airlineCodes.map(async (code) => {
      const name = await getAirlineNameByCode(code);
      if (name) airlineNameByCode[code] = name;
    }),
  );

  const statusCodes = Array.from(new Set(parsed.flights.map((f) => f.statusCode).filter((x) => Boolean(x)))) as string[];
  const statusTextByCode = await getStatusTextNoByCode(statusCodes);

  const flightsEnriched: EnrichedFlight[] = parsed.flights.map((f) => ({
    ...f,
    airportName: airportNameByCode[f.airport] ?? f.airport,
    airlineName: airlineNameByCode[f.airline] ?? f.airline,
    statusTextNo: f.statusCode ? statusTextByCode[f.statusCode] : undefined,
  }));

  return {
    ...parsed,
    feedUrl: feedUrl.toString(),
    airport,
    direction: direction ?? "BOTH",
    timeFrom,
    timeTo,
    flights: flightsEnriched,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const direction = parseDirection(url.searchParams.get("direction"));
    const timeFrom = parseHours(url.searchParams.get("timeFrom"), 1);
    const timeTo = parseHours(url.searchParams.get("timeTo"), 24);
    const airport = parseAirport(url.searchParams.get("airport"));
    const key = `${airport}|${direction ?? "BOTH"}|${timeFrom}|${timeTo}`;
    const cached = routeCache.get(key);
    const now = Date.now();

    if (cached && now - cached.fetchedAtMs < routeMinRefreshMs) {
      return NextResponse.json(withCacheStatus(cached.payload, "cached"), { headers: noStoreHeaders() });
    }

    let inFlight = routeInFlight.get(key);
    let createdInFlight = false;
    if (!inFlight) {
      inFlight = buildFlightsPayload(airport, direction, timeFrom, timeTo);
      routeInFlight.set(key, inFlight);
      createdInFlight = true;
    }

    try {
      const payload = await inFlight;
      routeCache.set(key, { fetchedAtMs: now, payload });
      return NextResponse.json(
        withCacheStatus(payload, createdInFlight ? "fresh" : "cached"),
        { headers: noStoreHeaders() },
      );
    } catch {
      if (cached) {
        return NextResponse.json(withCacheStatus(cached.payload, "cached"), {
          headers: {
            ...noStoreHeaders(),
            "X-Data-Stale": "1",
          },
        });
      }
      return NextResponse.json({ error: "UPSTREAM_UNAVAILABLE" }, { status: 502 });
    } finally {
      routeInFlight.delete(key);
    }
  } catch {
    return NextResponse.json({ error: "UPSTREAM_UNAVAILABLE" }, { status: 502 });
  }
}

