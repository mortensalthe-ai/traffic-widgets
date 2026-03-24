import { XMLParser } from "fast-xml-parser";

export type FlightDirection = "A" | "D";

export type Flight = {
  uniqueId: string;
  flightId: string;
  direction: FlightDirection;
  scheduleTimeUtc: string;
  airport: string;
  airline: string;
  domInt: "D" | "I" | "S" | string;
  statusCode?: string;
  statusTimeUtc?: string;
  gate?: string;
  beltNumber?: string;
  checkIn?: string;
};

export type FlightsResponse = {
  airport: string;
  lastUpdateUtc?: string;
  flights: Flight[];
};

const statusFallback: Record<string, string> = {
  A: "Arrived",
  C: "Cancelled",
  D: "Departed",
  E: "New time",
  N: "New info",
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function pickText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

export function normalizeAvinorXml(xml: string): FlightsResponse {
  const parsed = parser.parse(xml) as unknown;
  const root = (parsed as { airport?: unknown }).airport ?? parsed;

  const rootRecord = typeof root === "object" && root != null ? (root as Record<string, unknown>) : undefined;
  const flightsNode = rootRecord ? rootRecord["flights"] : undefined;
  const flightsNodeRecord = typeof flightsNode === "object" && flightsNode != null ? (flightsNode as Record<string, unknown>) : undefined;

  const lastUpdateUtc = pickText(flightsNodeRecord?.["@_lastUpdate"]);

  const flightsRaw = asArray<unknown>(flightsNodeRecord?.["flight"] as unknown as unknown | unknown[] | undefined);

  const flights: Flight[] = flightsRaw
    .map((f) => {
      const flightRec = typeof f === "object" && f != null ? (f as Record<string, unknown>) : undefined;
      const statusRec = flightRec && typeof flightRec["status"] === "object" && flightRec["status"] != null
        ? (flightRec["status"] as Record<string, unknown>)
        : undefined;

      const statusCode = pickText(statusRec?.["@_code"]);
      const statusTimeUtc = pickText(statusRec?.["@_time"]);

      return {
        uniqueId: pickText(flightRec?.["@_uniqueID"]) ?? pickText(flightRec?.["@_uniqueId"]) ?? "",
        flightId: pickText(flightRec?.["flight_id"]) ?? "",
        direction: (pickText(flightRec?.["arr_dep"]) as FlightDirection) ?? "D",
        scheduleTimeUtc: pickText(flightRec?.["schedule_time"]) ?? "",
        airport: pickText(flightRec?.["airport"]) ?? "",
        airline: pickText(flightRec?.["airline"]) ?? "",
        domInt: pickText(flightRec?.["dom_int"]) ?? "",
        statusCode,
        statusTimeUtc,
        gate: pickText(flightRec?.["gate"]),
        // Avinor XML has used both `belt_number` and `belt` (observed in the public feed).
        beltNumber: pickText(flightRec?.["belt_number"]) ?? pickText(flightRec?.["belt"]),
        checkIn: pickText(flightRec?.["check_in"]),
      };
    })
    .filter((f) => f.uniqueId && f.flightId && f.scheduleTimeUtc);

  return {
    airport:
      pickText(rootRecord?.["@_name"]) ?? pickText(rootRecord?.["@_airport"]) ?? "SVG",
    lastUpdateUtc,
    flights,
  };
}

export function statusLabel(code?: string): string {
  if (!code) return "Scheduled";
  return statusFallback[code] ?? code;
}

