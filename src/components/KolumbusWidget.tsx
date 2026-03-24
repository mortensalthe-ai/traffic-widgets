"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FaBus, FaFerry, FaTrainTram } from "react-icons/fa6";

type Message = {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  startTime?: string;
  endTime?: string;
  updatedTime?: string;
  affectedStops: string[];
  affectedLines: string[];
  affectedModes: string[];
  progress?: string;
  reportType?: string;
  rawJson: string;
};

type ApiResponse = {
  lastUpdatedUtc?: string;
  messages?: Message[];
  error?: string;
};

function toErrorCode(raw: string | undefined): string {
  const normalized = (raw ?? "").trim();
  if (!normalized) return "WIDGET_UNKNOWN";
  if (/AbortError/i.test(normalized)) return "WIDGET_TIMEOUT";
  if (/UPSTREAM_UNAVAILABLE/i.test(normalized)) return "WIDGET_UPSTREAM_UNAVAILABLE";
  if (/UPSTREAM_FEED_FAILED/i.test(normalized)) return "WIDGET_UPSTREAM_FEED_FAILED";
  if (/HTTP\s*\d+/i.test(normalized)) return "WIDGET_HTTP_ERROR";
  return "WIDGET_FETCH_FAILED";
}

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [450, 900] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function KolumbusWidget() {
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [lastUpdatedUtc, setLastUpdatedUtc] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [expandedRawById, setExpandedRawById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      let lastError: unknown;

      for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
        if (cancelled) return;

        let timeoutId: number | null = null;
        try {
          const controller = new AbortController();
          timeoutId = window.setTimeout(() => controller.abort(), 8000);
          const res = await fetch(`/api/kolumbus-messages?cacheBust=${Date.now()}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          if (timeoutId) window.clearTimeout(timeoutId);
          timeoutId = null;

          let json: ApiResponse | null = null;
          try {
            json = (await res.json()) as ApiResponse;
          } catch {
            json = null;
          }

          if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
          if (!json || !Array.isArray(json.messages)) throw new Error("INVALID_RESPONSE");

          if (!cancelled) {
            setMessages(json.messages);
            setLastUpdatedUtc(json.lastUpdatedUtc ?? "");
            setExpandedRawById({});
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
        const technical = lastError instanceof Error ? lastError.message : "Ukjent feil";
        setError(`Feilkode: ${toErrorCode(technical)}`);
        setLoading(false);
      }
    }

    load();
    const id = window.setInterval(load, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const shown = useMemo(() => messages.slice(0, 25), [messages]);

  function transportIcon(type: string): ReactNode {
    if (type === "båt") {
      return <FaFerry className="h-4 w-4 text-blue-900" aria-hidden="true" />;
    }
    if (type === "tog") {
      return <FaTrainTram className="h-4 w-4 text-blue-900" aria-hidden="true" />;
    }
    if (type === "trikk") {
      return <FaTrainTram className="h-4 w-4 text-blue-900" aria-hidden="true" />;
    }
    return <FaBus className="h-4 w-4 text-blue-900" aria-hidden="true" />;
  }

  function primaryTransportType(m: Message): string {
    if (m.affectedModes?.length) return m.affectedModes[0];
    const lineText = (m.affectedLines ?? []).join(" ").toLowerCase();
    if (lineText.includes("båt")) return "båt";
    if (lineText.includes("tog")) return "tog";
    if (lineText.includes("trikk")) return "trikk";
    return "buss";
  }

  function fmtDate(isoUtc: string | undefined): string {
    if (!isoUtc) return "—";
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("nb-NO", {
      timeZone: "Europe/Oslo",
      day: "2-digit",
      month: "long",
    }).format(d);
  }

  function fmtDateRange(startIso: string | undefined, endIso: string | undefined): string {
    const start = fmtDate(startIso);
    const end = fmtDate(endIso);
    if (start === "—" && end === "—") return "Ukjent periode";
    if (start !== "—" && end !== "—" && start !== end) return `${start} - ${end}`;
    return start !== "—" ? start : end;
  }

  return (
    <section className="w-full max-w-5xl rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="border-b border-zinc-200 p-4">
        <h2 className="text-base font-semibold tracking-tight text-zinc-950">Kolumbus driftsmeldinger</h2>
        <p className="mt-1 text-xs text-zinc-600">
          {lastUpdatedUtc
            ? `Sist oppdatert: ${new Intl.DateTimeFormat("nb-NO", {
                timeZone: "Europe/Oslo",
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(lastUpdatedUtc))}`
            : "Oppdateres automatisk"}
        </p>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">Laster driftsmeldinger…</div>
        ) : error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            Kunne ikke hente driftsmeldinger akkurat nå.
            <div className="mt-2 text-[11px] text-red-700">{error}</div>
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
            Ingen aktive driftsmeldinger akkurat nå.
          </div>
        ) : (
          <div className="flex flex-col">
            {shown.map((m) => (
              <div key={m.id} className="border-b border-zinc-200 px-3 py-3 last:border-b-0 hover:bg-zinc-50">
                <div className="flex items-center justify-between gap-2 text-[11px] font-semibold text-zinc-500">
                  <div className="flex items-center gap-2">
                  <span>{transportIcon(primaryTransportType(m))}</span>
                  <span>{fmtDateRange(m.startTime, m.endTime)}</span>
                  </div>
                  <button
                    type="button"
                    aria-expanded={Boolean(expandedRawById[m.id])}
                    onClick={() =>
                      setExpandedRawById((prev) => ({
                        ...prev,
                        [m.id]: !prev[m.id],
                      }))
                    }
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-zinc-300 bg-white text-[11px] font-bold text-zinc-700 hover:bg-zinc-100"
                    title="Vis rådata"
                  >
                    i
                  </button>
                </div>
                <a href={m.url} target="_blank" rel="noreferrer" className="mt-1 block text-sm font-semibold text-zinc-950 underline">
                  {m.title}
                </a>
                {m.excerpt ? <div className="mt-0.5 text-xs text-zinc-600">{m.excerpt}</div> : null}

                {m.affectedStops?.length || m.affectedLines?.length ? (
                  <div className="mt-2 grid gap-2 text-xs text-zinc-600 sm:grid-cols-2">
                    {m.affectedStops?.length ? (
                      <div>
                        <div className="font-semibold text-zinc-700">Berørte holdeplasser</div>
                        <ul className="mt-1 list-disc pl-4">
                          {m.affectedStops.map((s) => (
                            <li key={`${m.id}-stop-${s}`}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {m.affectedLines?.length ? (
                      <div>
                        <div className="font-semibold text-zinc-700">Berørte linjer</div>
                        <ul className="mt-1 list-disc pl-4">
                          {m.affectedLines.map((l) => (
                            <li key={`${m.id}-line-${l}`}>{l}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-zinc-600">
                  <span>
                    <span className="font-semibold text-zinc-700">Status:</span> {m.progress ?? "ukjent"}
                  </span>
                  <span>
                    <span className="font-semibold text-zinc-700">Type:</span> {m.reportType ?? "ukjent"}
                  </span>
                </div>
                {expandedRawById[m.id] ? (
                  <div className="mt-2 grid gap-2">
                    <div>
                      <div className="text-[11px] font-semibold text-zinc-700">Rå JSON</div>
                      <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2 text-[10px] text-zinc-700">
                        {m.rawJson}
                      </pre>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

