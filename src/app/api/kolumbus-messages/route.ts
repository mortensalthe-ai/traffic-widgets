import { NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";

export const dynamic = "force-dynamic";

type KolumbusMessage = {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  severity?: string;
  startTime?: string;
  endTime?: string;
  createdTime?: string;
  updatedTime?: string;
  affectedStops: string[];
  affectedLines: string[];
  affectedModes: string[];
  progress?: string;
  reportType?: string;
  rawJson: string;
};

const sourceUrl = "https://api.entur.io/realtime/v1/rest/sx?datasetId=KOL";
const fallbackInfoUrl = "https://www.kolumbus.no/reise/trafikkinfo/";
const timeoutMs = 8000;
const routeMinRefreshMs = 60_000;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

type KolumbusRoutePayload = {
  sourceUrl: string;
  fallbackInfoUrl: string;
  lastUpdatedUtc: string;
  messages: KolumbusMessage[];
};

type KolumbusRouteCacheEntry = {
  fetchedAtMs: number;
  payload: KolumbusRoutePayload;
};

let routeCache: KolumbusRouteCacheEntry | undefined;
let routeInFlight: Promise<KolumbusRoutePayload> | undefined;

function normalizeText(input: string | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[.,:;!?()/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickText(value: unknown): string {
  if (typeof value === "string") return normalizeText(value);
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  const direct = typeof obj["#text"] === "string" ? obj["#text"] : undefined;
  if (direct) return normalizeText(direct);
  const valueText = typeof obj.value === "string" ? obj.value : undefined;
  if (valueText) return normalizeText(valueText);
  return "";
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function normalizeMode(mode: string): string {
  const m = mode.toLowerCase();
  if (m.includes("bus") || m.includes("coach")) return "buss";
  if (m.includes("water") || m.includes("ferry") || m.includes("boat")) return "båt";
  if (m.includes("rail") || m.includes("train")) return "tog";
  if (m.includes("tram")) return "trikk";
  if (m.includes("metro") || m.includes("subway")) return "bane";
  return "transport";
}

function inferModeHint(text: string): string {
  const t = text.toLowerCase();
  if (/båt|hurtigbåt|ferje|samband|fjord1/.test(t)) return "båt";
  if (/tog|jernbane/.test(t)) return "tog";
  if (/trikk/.test(t)) return "trikk";
  return "buss";
}

function readableLine(refOrName: string): string {
  const text = refOrName.trim();
  const tail = text.split(":").pop() ?? text;
  const lineCode = tail.includes("_") ? (tail.split("_").pop() ?? tail) : tail;
  return lineCode.trim();
}

function lineNumberFromLineRef(lineRef: string): string {
  const tail = (lineRef.split(":").pop() ?? lineRef).trim();
  const code = tail.includes("_") ? (tail.split("_").pop() ?? tail).trim() : tail;
  if (/^\d{4}$/.test(code) && code.startsWith("20")) return code.slice(2); // 2015 -> 15
  if (/^\d{4}$/.test(code)) return code.slice(1); // 5200 -> 200, 4502 -> 502
  return code;
}

function fmtDepartureLabel(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  return ` (avgang ${time})`;
}

function extractPublicRouteLabels(text: string): string[] {
  const norm = text.replace(/\s+/g, " ");
  const matches = norm.match(/\b(SK\d{4}|N\d{2,3}|X\d{2,3}|E\d{2,3}|\d{2,3})\b/g) ?? [];
  return uniq(matches.map((m) => m.trim()));
}

function parseMessages(xml: string): KolumbusMessage[] {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const siri = parsed?.Siri as Record<string, unknown> | undefined;
  const serviceDelivery = siri?.ServiceDelivery as Record<string, unknown> | undefined;
  const sxDelivery = serviceDelivery?.SituationExchangeDelivery as Record<string, unknown> | undefined;
  const situations = sxDelivery?.Situations as Record<string, unknown> | undefined;
  const elements = asArray(situations?.PtSituationElement as Record<string, unknown> | undefined);

  const messages: KolumbusMessage[] = [];
  for (const el of elements) {
    const id = normalizeText(el?.SituationNumber as string | undefined);
    if (!id) continue;

    const summary = pickText(el?.Summary);
    const description = pickText(el?.Description);
    const publicRouteLabels = extractPublicRouteLabels(`${summary} ${description}`);
    const modeHint = inferModeHint(`${summary} ${description}`);
    const title = summary || "Driftsmelding";
    const excerpt = description;
    const severity = pickText(el?.Severity) || undefined;
    const createdTime = pickText(el?.CreationTime) || undefined;
    const updatedTime = pickText(el?.VersionedAtTime) || undefined;
    const progress = pickText(el?.Progress) || undefined;
    const reportType = pickText(el?.ReportType) || undefined;

    const validityList = asArray(el?.ValidityPeriod as Record<string, unknown> | undefined);
    const firstValidity = validityList[0];
    const startTime = pickText(firstValidity?.StartTime) || undefined;
    const endTime = pickText(firstValidity?.EndTime) || undefined;

    const affects = (el?.Affects as Record<string, unknown> | undefined) ?? {};
    const stopPoints = (affects.StopPoints as Record<string, unknown> | undefined) ?? {};
    const affectedStopPoints = asArray(stopPoints.AffectedStopPoint as Record<string, unknown> | undefined);
    const affectedStops = uniq(
      affectedStopPoints.map((sp) => pickText(sp.StopPointName) || pickText(sp.StopPointRef)).filter(Boolean),
    );

    const networks = (affects.Networks as Record<string, unknown> | undefined) ?? {};
    const affectedNetworks = asArray(networks.AffectedNetwork as Record<string, unknown> | undefined);
    const affectedModes = uniq(
      affectedNetworks
        .flatMap((network) => {
          const vehicleModes = asArray(
            ((network as Record<string, unknown>).VehicleModes as Record<string, unknown> | undefined)?.AffectedVehicleMode as
              | Record<string, unknown>
              | string
              | undefined,
          );
          return vehicleModes.map((vm) => normalizeMode(pickText(vm))).filter(Boolean);
        })
        .filter(Boolean),
    );

    const affectedLines = uniq(
      affectedNetworks.flatMap((network) => {
        const lines = asArray((network as Record<string, unknown>).AffectedLine as Record<string, unknown> | undefined);
        return lines
          .map((line) => {
            const refOrName = pickText(line.PublishedLineName) || pickText(line.LineRef);
            if (!refOrName) return "";
            return readableLine(refOrName);
          })
          .filter(Boolean);
      }),
    );

    const vehicleJourneys = ((affects.VehicleJourneys as Record<string, unknown> | undefined) ?? {}) as Record<
      string,
      unknown
    >;
    const affectedVehicleJourneys = asArray(
      vehicleJourneys.AffectedVehicleJourney as Record<string, unknown> | undefined,
    );
    const vehicleJourneyLines = uniq(
      affectedVehicleJourneys
        .map((vj) => {
          const lineRef = pickText(vj.LineRef);
          if (!lineRef) return "";
          const number = lineNumberFromLineRef(lineRef);
          const dep = fmtDepartureLabel(pickText(vj.OriginAimedDepartureTime));
          const modeText = affectedModes.length ? affectedModes.join("/") : modeHint;
          return `${modeText} ${number}${dep}`.trim();
        })
        .filter(Boolean),
    );
    const mergedLines = publicRouteLabels.length ? publicRouteLabels : uniq([...affectedLines, ...vehicleJourneyLines]);

    messages.push({
      id,
      title,
      excerpt,
      url: fallbackInfoUrl,
      severity,
      startTime,
      endTime,
      createdTime,
      updatedTime,
      affectedStops,
      affectedLines: mergedLines,
      affectedModes,
      progress,
      reportType,
      rawJson: JSON.stringify(el, null, 2),
    });
  }

  const sorted = messages.sort((a, b) => {
    const aTs = Date.parse(a.updatedTime ?? a.startTime ?? a.createdTime ?? "");
    const bTs = Date.parse(b.updatedTime ?? b.startTime ?? b.createdTime ?? "");
    const aVal = Number.isFinite(aTs) ? aTs : 0;
    const bVal = Number.isFinite(bTs) ? bTs : 0;
    return bVal - aVal;
  });

  return sorted.slice(0, 80);
}

type TrafficInfoEntry = {
  title: string;
  url: string;
  normalized: string;
};

function toAbsoluteUrl(rawHref: string): string {
  if (rawHref.startsWith("http://") || rawHref.startsWith("https://")) return rawHref;
  if (rawHref.startsWith("/")) return `https://www.kolumbus.no${rawHref}`;
  return `https://www.kolumbus.no/${rawHref}`;
}

function parseTrafficInfoEntries(html: string): TrafficInfoEntry[] {
  const anchors = Array.from(
    html.matchAll(/<a\b[^>]*href="([^"]*\/reise\/trafikkinfo\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi),
  );
  const res: TrafficInfoEntry[] = [];
  const seen = new Set<string>();
  for (const match of anchors) {
    const href = match[1] ?? "";
    if (!href || href.includes("/expired-traffic-info/")) continue;
    const url = toAbsoluteUrl(href);
    if (seen.has(url)) continue;
    const titleRaw = (match[2] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!titleRaw) continue;
    const title = titleRaw.split("»")[0]?.trim() ?? titleRaw;
    const normalized = normalizeForMatch(title);
    if (!normalized) continue;
    res.push({ title, url, normalized });
    seen.add(url);
  }
  return res;
}

function resolveMessageUrl(message: KolumbusMessage, entries: TrafficInfoEntry[]): string {
  const target = normalizeForMatch(`${message.title} ${message.excerpt}`);
  if (!target) return fallbackInfoUrl;
  for (const e of entries) {
    if (target.includes(e.normalized) || e.normalized.includes(normalizeForMatch(message.title))) {
      return e.url;
    }
  }
  return fallbackInfoUrl;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "ET-Client-Name": process.env.ENTUR_CLIENT_NAME || "trafikken-widget",
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "no-store, max-age=0, s-maxage=0, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

async function buildKolumbusPayload(): Promise<KolumbusRoutePayload> {
  const res = await fetchWithTimeout(sourceUrl);
  if (!res.ok) {
    throw new Error("UPSTREAM_FEED_FAILED");
  }

  const xml = await res.text();
  const messages = parseMessages(xml);

  // Resolve to per-message Kolumbus pages (when available).
  let trafficInfoEntries: TrafficInfoEntry[] = [];
  try {
    const pageRes = await fetchWithTimeout(fallbackInfoUrl);
    if (pageRes.ok) {
      const html = await pageRes.text();
      trafficInfoEntries = parseTrafficInfoEntries(html);
    }
  } catch {
    // Keep fallback URL on lookup failures.
  }

  const messagesWithLinks = messages.map((m) => ({
    ...m,
    url: resolveMessageUrl(m, trafficInfoEntries),
  }));

  return {
    sourceUrl,
    fallbackInfoUrl,
    lastUpdatedUtc: new Date().toISOString(),
    messages: messagesWithLinks,
  };
}

export async function GET() {
  try {
    const now = Date.now();
    if (routeCache && now - routeCache.fetchedAtMs < routeMinRefreshMs) {
      return NextResponse.json(routeCache.payload, { headers: noStoreHeaders() });
    }

    if (!routeInFlight) {
      routeInFlight = buildKolumbusPayload();
    }

    try {
      const payload = await routeInFlight;
      routeCache = { fetchedAtMs: Date.now(), payload };
      return NextResponse.json(payload, { headers: noStoreHeaders() });
    } catch {
      if (routeCache) {
        return NextResponse.json(routeCache.payload, {
          headers: {
            ...noStoreHeaders(),
            "X-Data-Stale": "1",
          },
        });
      }
      return NextResponse.json({ error: "UPSTREAM_UNAVAILABLE" }, { status: 502 });
    } finally {
      routeInFlight = undefined;
    }
  } catch {
    return NextResponse.json({ error: "UPSTREAM_UNAVAILABLE" }, { status: 502 });
  }
}

