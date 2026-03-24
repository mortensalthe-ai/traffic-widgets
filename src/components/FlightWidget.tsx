"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Direction = "D" | "A";
type AirportCode = "SVG" | "BGO" | "OSL" | "TRD";

type Flight = {
  uniqueId: string;
  flightId: string;
  direction: "A" | "D";
  scheduleTimeUtc: string;
  airport: string;
  airportName?: string;
  airline: string;
  airlineName?: string;
  domInt: string;
  statusCode?: string;
  statusTextNo?: string;
  statusTimeUtc?: string;
  gate?: string;
  beltNumber?: string;
  checkIn?: string;
};

type WidgetData = {
  lastUpdateUtc?: string;
  flights: Flight[];
};

type ApiFlightsResponse = WidgetData & {
  // Present only on error payloads.
  error?: string;
  airport?: string;
  feedUrl?: string;
  direction?: string;
  timeFrom?: number;
  timeTo?: number;
};

type WidgetError = {
  userMessage: string;
  technicalDetails?: string;
};

/** Antall forsøk ved nettverks-/serverfeil før feilmelding vises. */
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [450, 900] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function fmtTime(isoUtc: string | undefined) {
  if (!isoUtc) return "";
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function statusLabel(code?: string): string {
  if (!code) return "Scheduled";
  if (code === "A") return "Ankommet";
  if (code === "C") return "Kansellert";
  if (code === "D") return "Avgått";
  if (code === "E") return "Ny tid";
  if (code === "N") return "Ny info";
  return code;
}

function effectiveStatus(flight: Flight): { code?: string; label: string; showStatusTime: boolean } {
  const code = flight.statusCode;
  if (code === "E" && flight.statusTimeUtc && flight.scheduleTimeUtc) {
    const oldMs = Date.parse(flight.scheduleTimeUtc);
    const newMs = Date.parse(flight.statusTimeUtc);

    if (Number.isFinite(oldMs) && Number.isFinite(newMs)) {
      const deviationMs = Math.abs(newMs - oldMs);
      const deviationOk = deviationMs > 15 * 60 * 1000; // > 15 minutes
      const newInFuture = newMs > Date.now();

      if (deviationOk && newInFuture) {
        return { code: "E", label: "Ny tid", showStatusTime: false };
      }
    }

    return { code: undefined, label: "Scheduled", showStatusTime: false };
  }

  if (flight.statusTextNo) {
    return { code, label: flight.statusTextNo, showStatusTime: false };
  }

  return {
    code,
    label: statusLabel(code),
    showStatusTime: Boolean(flight.statusTimeUtc),
  };
}

function statusClass(code?: string): string {
  if (code === "C") return "bg-red-50 text-red-700 ring-red-200";
  // Blue-ish “positive” styling to better match the examples.
  if (code === "D" || code === "A") return "bg-sky-50 text-sky-700 ring-sky-200";
  if (code === "E" || code === "N") return "bg-amber-50 text-amber-800 ring-amber-200";
  return "bg-zinc-50 text-zinc-700 ring-zinc-200";
}

export function FlightWidget() {
  const [direction, setDirection] = useState<Direction>("D");
  const [airport, setAirport] = useState<AirportCode>("SVG");
  const [data, setData] = useState<WidgetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<WidgetError | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  /** Vis resten av listen (kun én vei — som «tidligere» øverst). */
  const [showLaterRows, setShowLaterRows] = useState(false);
  /** Utvidet tidsvindu bakover (Avinor TimeFrom: 24 t vs 1 t). */
  const [showEarlier, setShowEarlier] = useState(false);

  const airportLabels: Record<AirportCode, string> = {
    SVG: "Stavanger Lufthavn Sola (SVG)",
    BGO: "Bergen lufthavn Flesland (BGO)",
    OSL: "Oslo Lufthavn Gardermoen (OSL)",
    TRD: "Trondheim lufthavn Vaernes (TRD)",
  };

  type UserMessageError = Error & { __userMessage?: string };

  const [updatedUids, setUpdatedUids] = useState<Set<string>>(new Set());
  const prevSignatureByUidRef = useRef<Map<string, string>>(new Map());
  const manualFetchRef = useRef(false);
  const clearUpdatedTimerRef = useRef<number | null>(null);
  const hasInitialFetchRef = useRef(false);

  const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localYmd = (d: Date) => ymdFormatter.format(d);
  const nowKey = localYmd(new Date());
  const [nowY, nowM, nowD] = nowKey.split("-").map((x) => Number(x));
  const yesterdayKey = localYmd(new Date(Date.UTC(nowY, nowM - 1, nowD - 1, 12, 0, 0)));
  const tomorrowKey = localYmd(new Date(Date.UTC(nowY, nowM - 1, nowD + 1, 12, 0, 0)));

  function flightSignature(f: Flight): string {
    return [
      f.statusCode ?? "",
      f.statusTextNo ?? "",
      f.statusTimeUtc ?? "",
      f.gate ?? "",
      f.beltNumber ?? "",
      f.airportName ?? f.airport ?? "",
      f.airlineName ?? f.airline ?? "",
    ].join("|");
  }

  function toErrorCode(raw: string | undefined): string {
    const normalized = (raw ?? "").trim();
    if (!normalized) return "WIDGET_UNKNOWN";
    if (/AbortError/i.test(normalized)) return "WIDGET_TIMEOUT";
    if (/UPSTREAM_UNAVAILABLE/i.test(normalized)) return "WIDGET_UPSTREAM_UNAVAILABLE";
    if (/UPSTREAM_FEED_FAILED/i.test(normalized)) return "WIDGET_UPSTREAM_FEED_FAILED";
    if (/Unexpected end of JSON input/i.test(normalized)) return "WIDGET_INVALID_JSON";
    if (/HTTP\s*\d+/i.test(normalized)) return "WIDGET_HTTP_ERROR";
    return "WIDGET_FETCH_FAILED";
  }

  useEffect(() => {
    const id = setInterval(() => setRefreshIndex((x) => x + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (clearUpdatedTimerRef.current) window.clearTimeout(clearUpdatedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      setShowErrorDetails(false);

      const cacheBust = refreshIndex;
      const timeFrom = showEarlier ? 24 : 1;
      const url = `/api/flights?airport=${airport}&direction=${direction}&timeFrom=${timeFrom}&timeTo=24&cacheBust=${cacheBust}`;

      let lastError: unknown;

      for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
        if (cancelled) return;

        let timeoutId: number | null = null;
        try {
          const controller = new AbortController();
          timeoutId = window.setTimeout(() => controller.abort(), 8000);
          const res = await fetch(url, { cache: "no-store", signal: controller.signal });
          if (timeoutId) window.clearTimeout(timeoutId);
          timeoutId = null;

          let json: ApiFlightsResponse | undefined;
          let parseErr: unknown;
          try {
            json = (await res.json()) as ApiFlightsResponse;
          } catch (e) {
            parseErr = e;
          }

          if (!res.ok) {
            const technical = json?.error ?? (parseErr instanceof Error ? parseErr.message : `HTTP ${res.status}`);
            throw new Error(technical);
          }

          if (!json) {
            const technical = parseErr instanceof Error ? parseErr.message : "Tomt svar";
            const userMessage = "Kunne ikke hente flystatus akkurat nå. Prøv igjen om et øyeblikk.";
            throw Object.assign(new Error(technical), { __userMessage: userMessage }) as UserMessageError;
          }

          if (!cancelled) {
            const nextFlights = json.flights;
            const wasManual = manualFetchRef.current;
            manualFetchRef.current = false;

            // Første automatiske innlasting skal ikke "flash'e" alle rader.
            if (wasManual || hasInitialFetchRef.current) {
              if (!wasManual) {
                const prevMap = prevSignatureByUidRef.current;
                const nextMap = new Map<string, string>();
                const changed = new Set<string>();

                for (const f of nextFlights) {
                  const uid = f.uniqueId;
                  const sig = flightSignature(f);
                  nextMap.set(uid, sig);
                  if (prevMap.get(uid) !== sig) changed.add(uid);
                }

                prevSignatureByUidRef.current = nextMap;
                setUpdatedUids(changed);

                if (clearUpdatedTimerRef.current) window.clearTimeout(clearUpdatedTimerRef.current);
                // Fjern highlight etter hold + langsom fade.
                clearUpdatedTimerRef.current = window.setTimeout(() => setUpdatedUids(new Set()), 34_000);
              } else {
                const nextMap = new Map<string, string>();
                for (const f of nextFlights) {
                  nextMap.set(f.uniqueId, flightSignature(f));
                }
                prevSignatureByUidRef.current = nextMap;
                setUpdatedUids(new Set());
              }
            } else {
              // Første load
              const nextMap = new Map<string, string>();
              for (const f of nextFlights) {
                nextMap.set(f.uniqueId, flightSignature(f));
              }
              prevSignatureByUidRef.current = nextMap;
              setUpdatedUids(new Set());
            }

            hasInitialFetchRef.current = true;
            setData({ lastUpdateUtc: json.lastUpdateUtc, flights: nextFlights });
          }

          if (!cancelled) setLoading(false);
          return;
        } catch (e) {
          if (timeoutId) window.clearTimeout(timeoutId);
          lastError = e;
          if (cancelled) return;
          if (attempt < FETCH_MAX_ATTEMPTS - 1) {
            await delay(FETCH_RETRY_DELAYS_MS[attempt] ?? 600);
          }
        }
      }

      if (!cancelled) {
        const technical =
          lastError instanceof Error
            ? lastError.message
            : typeof lastError === "string"
              ? lastError
              : "Ukjent feil";
        const userMessage =
          lastError instanceof Error
            ? typeof (lastError as UserMessageError).__userMessage === "string"
              ? (lastError as UserMessageError).__userMessage
              : undefined
            : undefined;
        const maskedTechnical = `Feilkode: ${toErrorCode(technical)}`;
        setError({
          userMessage: userMessage ?? "Kunne ikke hente flystatus akkurat nå. Prøv igjen om et øyeblikk.",
          technicalDetails: maskedTechnical,
        });
        setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [direction, refreshIndex, airport, showEarlier]);

  const maxLines = 15;
  const initialEarlierCount = 5;
  const initialPendingCount = 10;
  const sortedFlights = useMemo(() => {
    const list = data?.flights ?? [];
    // Ikke kutt listen her: «senere» skal kunne nå morgendagens fly også ved store datamengder.
    return [...list].sort((a, b) => a.scheduleTimeUtc.localeCompare(b.scheduleTimeUtc));
  }, [data]);

  const displayedFlights = useMemo(() => {
    if (showLaterRows) return sortedFlights;
    const nowMs = Date.now();
    const completedCode = direction === "D" ? "D" : "A";

    const earlierCompleted = sortedFlights
      .filter((f) => Date.parse(f.scheduleTimeUtc) < nowMs && f.statusCode === completedCode)
      .slice(-initialEarlierCount);

    const pending = sortedFlights
      .filter((f) => f.statusCode !== completedCode)
      .slice(0, initialPendingCount);

    const picked = [...earlierCompleted, ...pending];
    if (picked.length === 0) return sortedFlights.slice(0, maxLines);

    const byId = new Map<string, Flight>();
    for (const f of picked) byId.set(f.uniqueId, f);
    return [...byId.values()].sort((a, b) => a.scheduleTimeUtc.localeCompare(b.scheduleTimeUtc));
  }, [showLaterRows, sortedFlights, direction]);

  const showLaterButton = sortedFlights.length > displayedFlights.length && !showLaterRows;
  // Under automatisk refresh (interval) skal vi ikke tømme listen.
  // Vis spinner i stedet bare når vi faktisk ikke har noe data enda (første load)
  // eller når bruker har trigget et bevisst "reset" (data=null).
  const showSpinner = loading && !data && !error;
  /** Pil øverst i listen for å laste inn eldre fly (utvider tidsvindu bakover). */
  const showEarlierArrow = !showEarlier && data !== null && !loading && !error;

  function renderTime(f: Flight) {
    const schedule = fmtTime(f.scheduleTimeUtc);
    const scheduleRelativeDayLabel: string | null = (() => {
      const d = new Date(f.scheduleTimeUtc);
      if (Number.isNaN(d.getTime())) return null;
      const key = localYmd(d);
      if (key === yesterdayKey) return "i går";
      if (key === tomorrowKey) return "i morgen";
      return null;
    })();
    const newTime = f.statusTimeUtc ? fmtTime(f.statusTimeUtc) : "";
    const timeChanged = (() => {
      if (!f.statusTimeUtc) return false;
      // Sammenlign det som faktisk vises (klokkeslett til minutt),
      // så vi ikke stryker over når bare sekunder/mindre avvik endrer seg.
      return schedule !== newTime;
    })();
    if (!timeChanged) {
      return (
        <>
          <span>{schedule}</span>
          {scheduleRelativeDayLabel ? (
            <div className="text-[11px] font-semibold text-zinc-500 leading-tight">{scheduleRelativeDayLabel}</div>
          ) : null}
        </>
      );
    }

    return (
      <>
        <span className="line-through opacity-70">{schedule}</span>
        <br />
        <span>{newTime}</span>
        {scheduleRelativeDayLabel ? (
          <div className="text-[11px] font-semibold text-zinc-500 leading-tight">{scheduleRelativeDayLabel}</div>
        ) : null}
      </>
    );
  }

  return (
    <section className="w-full max-w-5xl rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
            <h2 className="text-base font-semibold tracking-tight text-zinc-950">{airportLabels[airport]}</h2>
          <p className="text-xs text-zinc-600">
            Flystatus.
            {loading ? (
              <span className="ml-2 text-zinc-500 animate-pulse">Oppdaterer…</span>
            ) : data?.lastUpdateUtc ? (
              <span className="ml-2 text-zinc-500">Sist oppdatert: {fmtTime(data.lastUpdateUtc)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-md bg-zinc-100 p-1 ring-1 ring-zinc-200"
            role="tablist"
            aria-label="Avganger og ankomster"
          >
            <button
              type="button"
              role="tab"
              aria-selected={direction === "D"}
              onClick={() => {
                if (direction !== "D") {
                  manualFetchRef.current = true;
                  setData(null);
                  setShowEarlier(false);
                  setShowLaterRows(false);
                  setDirection("D");
                }
              }}
              className={[
                "px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 hover:-translate-y-px hover:shadow-sm active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2",
                direction === "D"
                  ? "bg-white shadow-sm text-zinc-950 ring-1 ring-zinc-200"
                  : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
              ].join(" ")}
            >
              Avganger
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={direction === "A"}
              onClick={() => {
                if (direction !== "A") {
                  manualFetchRef.current = true;
                  setData(null);
                  setShowEarlier(false);
                  setShowLaterRows(false);
                  setDirection("A");
                }
              }}
              className={[
                "px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 hover:-translate-y-px hover:shadow-sm active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2",
                direction === "A"
                  ? "bg-white shadow-sm text-zinc-950 ring-1 ring-zinc-200"
                  : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
              ].join(" ")}
            >
              Ankomster
            </button>
          </div>
          <div
            className="inline-flex rounded-md bg-zinc-100 p-1 ring-1 ring-zinc-200"
            role="tablist"
            aria-label="Flyplass"
          >
            {(["SVG", "BGO", "OSL", "TRD"] as AirportCode[]).map((code) => (
              <button
                key={code}
                type="button"
                role="tab"
                aria-selected={airport === code}
                onClick={() => {
                  if (airport !== code) {
                    manualFetchRef.current = true;
                    setData(null);
                    setShowEarlier(false);
                    setShowLaterRows(false);
                    setAirport(code);
                  }
                }}
                className={[
                  "px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 hover:-translate-y-px hover:shadow-sm active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2",
                  airport === code
                    ? "bg-white shadow-sm text-zinc-950 ring-1 ring-zinc-200"
                    : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
                ].join(" ")}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-4 pb-4 pt-0">
        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            <div>{error.userMessage}</div>
            {error.technicalDetails ? (
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowErrorDetails((x) => !x)}
                  className="inline-flex items-center rounded-md border border-red-200 bg-white/60 px-3 py-1 text-[11px] font-semibold text-red-800 hover:bg-white"
                >
                  {showErrorDetails ? "Skjul detaljer" : "Vis detaljer"}
                </button>
              </div>
            ) : null}
            {showErrorDetails && error.technicalDetails ? (
              <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-white/70 p-2 text-[11px] text-red-900">
                {error.technicalDetails}
              </pre>
            ) : null}
            <div className="mt-2 text-[11px] text-red-700">Hvis dette fortsetter, kan tjenesten være midlertidig utilgjengelig.</div>
          </div>
        ) : null}

        {/* Mobile list */}
        <div className="flex flex-col">
          {showSpinner ? (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
              <span className="inline-flex items-center gap-2">
                <svg
                  className="h-4 w-4 animate-spin text-zinc-600"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Laster…
              </span>
            </div>
          ) : (
            <>
              {showEarlierArrow ? (
                <div className="-mx-4 border-b border-zinc-100 bg-zinc-50/50 py-0">
                  <button
                    type="button"
                    aria-label={
                      direction === "D" ? "Last inn tidligere avganger" : "Last inn tidligere ankomster"
                    }
                    title={direction === "D" ? "Vis tidligere avganger" : "Vis tidligere ankomster"}
                    onClick={() => {
                      manualFetchRef.current = true;
                      setData(null);
                      setShowEarlier(true);
                      setShowLaterRows(false);
                    }}
                    className="flex h-5 w-full items-center justify-center gap-1.5 rounded-none border-0 bg-transparent py-0 text-zinc-400 transition-colors hover:bg-zinc-100/80 hover:text-zinc-600 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset"
                  >
                    <svg
                      className="h-3 w-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M18 15l-6-6-6 6" />
                    </svg>
                    <span className="text-[10px] font-medium leading-none">tidligere</span>
                  </button>
                </div>
              ) : null}
              {sortedFlights.length === 0 ? (
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                  Ingen fly i dette tidsrommet.
                </div>
              ) : (
                displayedFlights.map((f, idx) => {
              const status = effectiveStatus(f);
              const mobileStatusLabel = status.label;
              const isCancelled = status.code === "C";

              const gateOrBeltValue = direction === "D" ? f.gate : f.beltNumber;
              const gateOrBeltText =
                gateOrBeltValue && gateOrBeltValue !== "—"
                  ? direction === "D"
                    ? `Gate ${gateOrBeltValue}`
                    : `Bånd ${gateOrBeltValue}`
                  : "";

              const placeName = f.airportName ?? f.airport;
              const airlineName = f.airlineName ?? f.airline;

              return (
                <div
                  key={f.uniqueId}
                  className={`grid grid-cols-[70px_1fr_auto] items-start gap-x-3 border-b border-zinc-200 px-3 py-2 ${
                    updatedUids.has(f.uniqueId) ? "updated-row" : ""
                  } ${
                    showLaterRows && idx >= maxLines ? "reveal-row" : ""
                  } ${isCancelled ? "text-red-700" : ""}`}
                >
                  <div className={`text-sm font-semibold leading-tight ${isCancelled ? "text-red-700" : "text-zinc-950"}`}>
                    {renderTime(f)}
                  </div>
                  <div className="min-w-0">
                    <div className={`text-sm font-semibold leading-tight ${isCancelled ? "text-red-700" : "text-zinc-950"}`}>
                      {placeName}
                    </div>
                    <div className={`mt-0.5 truncate text-[11px] font-semibold ${isCancelled ? "text-red-700" : "text-zinc-700"}`}>
                      {f.flightId}
                      <span className="mx-2 text-zinc-400">|</span>
                      {airlineName}
                      {gateOrBeltText ? (
                        <>
                          <span className="mx-2 text-zinc-400">|</span>
                          {gateOrBeltText}
                        </>
                      ) : null}
                    </div>
                  </div>

                <div className="flex flex-col items-end">
                  {mobileStatusLabel !== "Scheduled" ? (
                    <span
                      className={[
                        "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap",
                        statusClass(status.code),
                      ].join(" ")}
                      title={
                        f.statusTimeUtc && f.statusTimeUtc !== f.scheduleTimeUtc
                          ? `Oppdatert: ${fmtTime(f.statusTimeUtc)}`
                          : undefined
                      }
                    >
                      {mobileStatusLabel}
                    </span>
                  ) : null}
                </div>
                </div>
              );
                })
              )}
            </>
          )}

          {showLaterButton ? (
            <div className="-mx-4 border-t border-zinc-100 bg-zinc-50/50 py-0">
              <button
                type="button"
                aria-label={`Vis ${sortedFlights.length - maxLines} flere fly i listen (senere)`}
                onClick={() => setShowLaterRows(true)}
                className="flex h-5 w-full items-center justify-center gap-1.5 rounded-none border-0 bg-transparent py-0 text-zinc-400 transition-colors hover:bg-zinc-100/80 hover:text-zinc-600 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset"
              >
                <svg
                  className="h-3 w-3 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="text-[10px] font-medium leading-none">senere</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="py-3 pr-4">Tid</th>
                <th className="py-3 pr-4">{direction === "D" ? "Til" : "Fra"}</th>
                <th className="py-3 pr-4">Fly</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3 pr-4">Gate</th>
                <th className="py-3 pr-4">Bånd</th>
              </tr>
            </thead>
            <tbody className="text-zinc-950">
              {showSpinner ? (
                <tr>
                  <td colSpan={6} className="py-6 text-zinc-600">
                    <span className="inline-flex items-center gap-2">
                      <svg
                        className="h-4 w-4 animate-spin text-zinc-600"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      Laster…
                    </span>
                  </td>
                </tr>
              ) : sortedFlights.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-zinc-600">
                    Ingen fly i dette tidsrommet.
                  </td>
                </tr>
              ) : (
                displayedFlights.map((f) => {
                  const status = effectiveStatus(f);
                  const isCancelled = status.code === "C";
                  return (
                    <tr
                      key={f.uniqueId}
                      className={`border-b border-zinc-100 last:border-b-0 ${updatedUids.has(f.uniqueId) ? "updated-row" : ""} ${
                        isCancelled ? "text-red-700" : ""
                      }`}
                    >
                      <td className="py-3 pr-4 font-medium">{renderTime(f)}</td>
                      <td className="py-3 pr-4">{f.airportName ?? f.airport}</td>
                      <td className="py-3 pr-4">
                        {f.flightId}
                        <span className="mx-2 text-zinc-400">|</span>
                        {f.airlineName ?? f.airline}
                      </td>
                      <td className="py-3 pr-4">
                        {status.label !== "Scheduled" ? (
                          <span
                            className={[
                              "inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset",
                              statusClass(status.code),
                            ].join(" ")}
                          >
                            {status.label}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-3 pr-4 text-zinc-700">{f.gate && f.gate !== "—" ? f.gate : ""}</td>
                      <td className="py-3 pr-4 text-zinc-700">{f.beltNumber && f.beltNumber !== "—" ? f.beltNumber : ""}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {showLaterButton ? (
            <div className="-mx-4 border-t border-zinc-100 bg-zinc-50/50 py-0">
              <button
                type="button"
                aria-label={`Vis ${sortedFlights.length - maxLines} flere fly i listen (senere)`}
                onClick={() => setShowLaterRows(true)}
                className="flex h-5 w-full items-center justify-center gap-1.5 rounded-none border-0 bg-transparent py-0 text-zinc-400 transition-colors hover:bg-zinc-100/80 hover:text-zinc-600 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset"
              >
                <svg
                  className="h-3 w-3 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="text-[10px] font-medium leading-none">senere</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-3 text-[11px] text-zinc-500">
          Data:{" "}
          <a className="underline hover:text-zinc-700" href="https://www.avinor.no" target="_blank" rel="noreferrer">
            Avinor
          </a>
          .
        </div>
      </div>
    </section>
  );
}

