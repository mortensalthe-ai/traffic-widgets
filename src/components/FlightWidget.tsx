"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type TransitionEvent,
} from "react";
import {
  effectiveStatus,
  statusClass,
  useOriginalTimeOnlyForSmallUpcomingDeviation,
} from "../lib/flightStatusConfig";
import { NORWEGIAN_AIRPORTS, norwegianAirportLabelByCode } from "../lib/norwegianAirports";

type Direction = "D" | "A";
type AirportCode = string;

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

/** Under paging: utvidet utsnitt av rader som glir i mobil-listepanelet. */
type ListPanelStrip = {
  kind: "later" | "earlier";
  flights: Flight[];
  nextWindow: { start: number; end: number };
};

/** Antall forsøk ved nettverks-/serverfeil før feilmelding vises. */
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAYS_MS = [450, 900] as const;

/** Alltid så mange synlige rader (når listen er lang nok). */
const FLIGHT_LIST_VISIBLE = 15;
/** Anker før «nå-linjen» i første vindu (innenfor de 15 radene). */
const FLIGHT_LIST_PAST_BEFORE_BOUNDARY = 5;
/** Bla «tidligere»/«senere» så mange rader om gangen. */
const FLIGHT_LIST_PAGE_STEP = 10;
/** Fast radhøyde (rem) — alle rader like høye på mobil og i tabell. */
const FLIGHT_LIST_ROW_HEIGHT_REM = 2.8;
/** Smal kolonne for HH:MM (+ ev. «i går» / forsinket to-linje); gir mer plass til rute og status. */
const FLIGHT_LIST_TIME_COL = "3.25rem";
/** Glid i mobil-listepanelet ved «tidligere»/«senere» (ikke sidescroll). */
const FLIGHT_LIST_PANEL_SLIDE_MS = 400;
/** Felles easing — «tidligere» bruker samme mønster som «senere» (snap → glid). */
const FLIGHT_LIST_PANEL_SLIDE_EASING = "cubic-bezier(0.33, 0.86, 0.25, 1)";

/** «tidligere» / «senere»: ingen tekstmarkering; tydelig stil når klikkbar (`enabled:`). */
const LIST_SCROLL_NAV_BUTTON_CLASS =
  "flex min-h-9 w-full select-none items-center justify-center gap-1.5 rounded-none border-0 bg-transparent py-1.5 transition-colors active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-inset " +
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:text-zinc-400 disabled:opacity-45 " +
  "enabled:cursor-pointer enabled:font-semibold enabled:text-zinc-800 enabled:hover:bg-zinc-100 enabled:hover:text-zinc-950 enabled:active:bg-zinc-200/70";

/** Vindu [start,end) med nøyaktig min(VISIBLE,n) rader, start nær ønsket indeks. */
function fixedWindowFromPreferredStart(preferredStart: number, n: number): { start: number; end: number } {
  const V = FLIGHT_LIST_VISIBLE;
  if (n === 0) return { start: 0, end: 0 };
  if (n <= V) return { start: 0, end: n };
  const s = Math.max(0, Math.min(preferredStart, n - V));
  return { start: s, end: s + V };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function flightRowHeightPx(): number {
  if (typeof document === "undefined") return 16 * FLIGHT_LIST_ROW_HEIGHT_REM;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
  return rem * FLIGHT_LIST_ROW_HEIGHT_REM;
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

/** Dato-nøkkel (YYYY-MM-DD) i Europe/Oslo — modulnivå for stabil SSR/klient. */
const osloDateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function formatYmdOslo(d: Date): string {
  return osloDateKeyFormatter.format(d);
}

/**
 * Avinor XML: `flight.airport` er motpartens IATA-kode (mål for avgang, avreise for ankomst).
 * Oppstrøms feed er allerede filtrert på airport+direction; vi beholder retning som sikkerhetsnett
 * (etter normalisert arr_dep i parse). Rad der motpart = hub er topologisk umulig som ordinær rute
 * og kommer ofte fra feil i feed (visning som «Bergen» på avgang fra Bergen).
 * Manglende airport-kode: behold raden (sjeldent; bedre enn å skjule gyldig fly).
 */
function flightMatchesSelectedView(f: Flight, hub: AirportCode, dir: Direction): boolean {
  if (f.direction !== dir) return false;
  const other = (f.airport ?? "").trim().toUpperCase();
  if (!other) return true;
  if (other === hub) return false;
  return true;
}


/** Første vindu: nøyaktig 15 rader (eller alle om færre totalt), anker rundt første planlagte tid ≥ nå. */
function initialListWindow(sorted: Flight[]): { start: number; end: number } {
  const n = sorted.length;
  const V = FLIGHT_LIST_VISIBLE;
  if (n === 0) return { start: 0, end: 0 };
  if (n <= V) return { start: 0, end: n };

  const nowMs = Date.now();
  let boundary = sorted.findIndex((f) => {
    const t = Date.parse(f.scheduleTimeUtc);
    return Number.isFinite(t) && t >= nowMs;
  });
  if (boundary < 0) boundary = n;

  if (boundary === n) {
    return { start: n - V, end: n };
  }

  const preferredStart = Math.max(0, boundary - FLIGHT_LIST_PAST_BEFORE_BOUNDARY);
  return fixedWindowFromPreferredStart(preferredStart, n);
}

export function FlightWidget() {
  const [direction, setDirection] = useState<Direction>("D");
  const [airport, setAirport] = useState<AirportCode>("SVG");
  const [data, setData] = useState<WidgetData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<WidgetError | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [refreshIndex, setRefreshIndex] = useState(0);
  /** Vindu inn i sortert liste: [windowStart, windowEnd). */
  const [windowStart, setWindowStart] = useState(0);
  const [windowEnd, setWindowEnd] = useState(0);
  /** Utvidet tidsvindu bakover (Avinor TimeFrom: 24 t vs 1 t). */
  const [showEarlier, setShowEarlier] = useState(false);
  /** 24t-henting pågår — holder «tidligere»-raden synlig uten layout-hopp. */
  const [earlierExpandLoading, setEarlierExpandLoading] = useState(false);
  /** translateY (px) for mobil flyliste i eget panel — tidligere/senere. */
  const [listPanelOffsetY, setListPanelOffsetY] = useState(0);
  const [listPanelSliding, setListPanelSliding] = useState(false);
  /** Når false: ingen transition (snap til start før «tidligere»), så vi ikke animerer 0→-X ved uhell. */
  const [listPanelTransformArmed, setListPanelTransformArmed] = useState(true);
  const mobileListPanelRef = useRef<HTMLDivElement | null>(null);
  const navTapTsRef = useRef(0);

  const airportLabels: Record<string, string> = norwegianAirportLabelByCode;
  const airportMenuRef = useRef<HTMLDivElement | null>(null);
  const airportMenuWrapRef = useRef<HTMLDivElement | null>(null);
  const airportMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [airportMenuOpen, setAirportMenuOpen] = useState(false);
  const [airportMenuPos, setAirportMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!airportMenuOpen) return;
    const btn = airportMenuButtonRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const margin = 8;
    const desired = 304; // ~19rem
    const width = Math.max(200, Math.min(desired, vw - margin * 2));
    const center = rect.left + rect.width / 2;
    const left = Math.max(margin, Math.min(center - width / 2, vw - width - margin));
    const top = rect.bottom + 8;
    setAirportMenuPos({ top, left, width });
  }, [airportMenuOpen]);

  useEffect(() => {
    if (!airportMenuOpen) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      // Klikk i menyen eller på menyknappen skal ikke lukke (menyvalg lukker selv).
      if (airportMenuRef.current && airportMenuRef.current.contains(t)) return;
      if (airportMenuButtonRef.current && airportMenuButtonRef.current.contains(t)) return;
      setAirportMenuOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [airportMenuOpen]);

  type UserMessageError = Error & { __userMessage?: string };

  const [updatedUids, setUpdatedUids] = useState<Set<string>>(new Set());
  const prevSignatureByUidRef = useRef<Map<string, string>>(new Map());
  const manualFetchRef = useRef(false);
  const clearUpdatedTimerRef = useRef<number | null>(null);
  const hasInitialFetchRef = useRef(false);
  /** Tom når listen er tømt — sørger for at ny flyplass/data alltid kjører initialListWindow. */
  const windowListKeyRef = useRef("");
  const prevSortedLenRef = useRef(0);
  /**
   * Ved 24t-«tidligere»: ikke scroll før ny data er på plass (unngår anvendelse på 1t-listen).
   * `listExpanded` når lengden øker eller første rad endrer seg (ny historikk foran).
   */
  const pendingEarlier24hRef = useRef<{
    topUid: string;
    /** Siste synlige rad før 24t — brukes til strip-lengde ved animasjon. */
    bottomUid: string;
    visibleCount: number;
    airport: AirportCode;
    direction: Direction;
    listLenAtClick: number;
    firstRowUidAtClick: string;
  } | null>(null);
  const [listPanelStrip, setListPanelStrip] = useState<ListPanelStrip | null>(null);
  const listPanelStripRef = useRef<ListPanelStrip | null>(null);
  useEffect(() => {
    listPanelStripRef.current = listPanelStrip;
  }, [listPanelStrip]);

  /** Unngår hydration-feil fra new Date()/Date.now() som avviker mellom server og første klient-render. */
  const [clientNowMs, setClientNowMs] = useState<number | null>(null);
  useEffect(() => {
    setClientNowMs(Date.now());
    const id = window.setInterval(() => setClientNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { yesterdayKey, tomorrowKey } = useMemo(() => {
    if (clientNowMs === null) {
      return { yesterdayKey: "__none__", tomorrowKey: "__none__" } as const;
    }
    const nowKey = formatYmdOslo(new Date(clientNowMs));
    const [nowY, nowM, nowD] = nowKey.split("-").map((x) => Number(x));
    return {
      yesterdayKey: formatYmdOslo(new Date(Date.UTC(nowY, nowM - 1, nowD - 1, 12, 0, 0))),
      tomorrowKey: formatYmdOslo(new Date(Date.UTC(nowY, nowM - 1, nowD + 1, 12, 0, 0))),
    };
  }, [clientNowMs]);

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
      // Bakgrunnsoppdatering (interval) skal ikke skjule listen eller «tidligere»-knappen.
      if (data === null) {
        setLoading(true);
      }
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
            setEarlierExpandLoading(false);

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
                  if (prevMap.has(uid) && prevMap.get(uid) !== sig) changed.add(uid);
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
        setEarlierExpandLoading(false);
        pendingEarlier24hRef.current = null;
        setListPanelStrip(null);
        setListPanelSliding(false);
        setListPanelTransformArmed(true);
        setListPanelOffsetY(0);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [direction, refreshIndex, airport, showEarlier]);

  const sortedFlights = useMemo(() => {
    const list = data?.flights ?? [];
    const filtered = list.filter((f) => flightMatchesSelectedView(f, airport, direction));
    return [...filtered].sort((a, b) => a.scheduleTimeUtc.localeCompare(b.scheduleTimeUtc));
  }, [data, airport, direction]);

  /** Før paint: unngå ett «blink» med gammelt vindu mens ny data (f.eks. 24t) allerede er i state. */
  useLayoutEffect(() => {
    const n = sortedFlights.length;
    const key = `${airport}|${direction}|${showEarlier}`;
    const keyChanged = windowListKeyRef.current !== key;
    const becameAvailable = prevSortedLenRef.current === 0 && n > 0;
    prevSortedLenRef.current = n;

    if (n === 0) {
      setWindowStart(0);
      setWindowEnd(0);
      windowListKeyRef.current = "";
      pendingEarlier24hRef.current = null;
      setListPanelStrip(null);
      setListPanelSliding(false);
      setListPanelTransformArmed(true);
      setListPanelOffsetY(0);
      return;
    }

    /** Ikke klem/tilordne vindu mens mobil-strip animerer (unngår hopp og dobbeltkjøring). */
    if (listPanelStrip !== null || listPanelSliding) {
      return;
    }

    const pend = pendingEarlier24hRef.current;
    const listExpandedForEarlier =
      pend &&
      showEarlier &&
      pend.topUid &&
      pend.airport === airport &&
      pend.direction === direction &&
      (n > pend.listLenAtClick ||
        (sortedFlights[0] !== undefined &&
          sortedFlights[0].uniqueId !== pend.firstRowUidAtClick));

    if (listExpandedForEarlier) {
      const idx =
        sortedFlights.findIndex((f) => f.uniqueId === pend!.topUid) >= 0
          ? sortedFlights.findIndex((f) => f.uniqueId === pend!.topUid)
          : sortedFlights.findIndex((f) => f.uniqueId === pend!.firstRowUidAtClick);
      pendingEarlier24hRef.current = null;
      if (idx >= 0) {
        // Når 24t-lista kommer inn: behandle klikket som et vanlig "bla 10 rader opp".
        // Hvis det finnes færre enn 10 nye rader, clampler vi til 0.
        const preferred = Math.max(0, idx - FLIGHT_LIST_PAGE_STEP);
        const { start, end } = fixedWindowFromPreferredStart(preferred, n);
        windowListKeyRef.current = key;

        const bottomUid = pend!.bottomUid;
        const idxBottom = bottomUid ? sortedFlights.findIndex((f) => f.uniqueId === bottomUid) : -1;
        const shift = idx - start;

        const canAnimate24hStrip =
          !prefersReducedMotion() &&
          shift > 0 &&
          idxBottom >= 0 &&
          !listPanelSliding &&
          listPanelStrip === null;

        if (canAnimate24hStrip) {
          const stripEnd = Math.min(
            n,
            Math.max(end, idxBottom + 1, idx + FLIGHT_LIST_VISIBLE),
          );
          const flights = sortedFlights.slice(start, stripEnd);
          const rowPx = flightRowHeightPx();
          setListPanelTransformArmed(false);
          setWindowStart(start);
          setWindowEnd(end);
          setListPanelStrip({ kind: "earlier", flights, nextWindow: { start, end } });
          setListPanelOffsetY(-shift * rowPx);
          setListPanelSliding(true);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setListPanelTransformArmed(true);
              requestAnimationFrame(() => {
                setListPanelOffsetY(0);
              });
            });
          });
          return;
        }

        setWindowStart(start);
        setWindowEnd(end);
        return;
      }
    }

    if (keyChanged || becameAvailable) {
      windowListKeyRef.current = key;
      if (
        pendingEarlier24hRef.current &&
        showEarlier &&
        pendingEarlier24hRef.current.airport === airport &&
        pendingEarlier24hRef.current.direction === direction &&
        n <= pendingEarlier24hRef.current.listLenAtClick &&
        sortedFlights[0]?.uniqueId === pendingEarlier24hRef.current.firstRowUidAtClick
      ) {
        return;
      }

      const { start, end } = initialListWindow(sortedFlights);
      setWindowStart(start);
      setWindowEnd(end);
      return;
    }

    const V = FLIGHT_LIST_VISIBLE;
    const span = windowEnd - windowStart;
    const needsClamp =
      windowStart < 0 ||
      windowEnd > n ||
      (n >= V && span !== V) ||
      (n < V && (windowStart !== 0 || windowEnd !== n));
    if (needsClamp) {
      const normalized = fixedWindowFromPreferredStart(windowStart, n);
      setWindowStart(normalized.start);
      setWindowEnd(normalized.end);
    }
  }, [airport, direction, showEarlier, sortedFlights.length, data, listPanelStrip, listPanelSliding]);

  const displayedFlights = useMemo(
    () => sortedFlights.slice(windowStart, windowEnd),
    [sortedFlights, windowStart, windowEnd],
  );

  const mobileListFlights = listPanelStrip ? listPanelStrip.flights : displayedFlights;
  const mobilePanelVisibleRows = listPanelStrip
    ? FLIGHT_LIST_VISIBLE
    : Math.min(FLIGHT_LIST_VISIBLE, sortedFlights.length);

  const canPageEarlier = windowStart > 0;
  const canLoadEarlierApi = windowStart === 0 && !showEarlier;
  const canUseLaterNav = windowEnd < sortedFlights.length;
  /** Knappene vises alltid når lista har rader; de gråes ut når handling ikke er tilgjengelig. */
  const earlierNavDisabled =
    listPanelSliding || earlierExpandLoading || (!canPageEarlier && !canLoadEarlierApi);
  const laterNavDisabled = listPanelSliding || !canUseLaterNav;
  // Under automatisk refresh (interval) skal vi ikke tømme listen.
  // Vis spinner i stedet bare når vi faktisk ikke har noe data enda (første load)
  // eller når bruker har trigget et bevisst "reset" (data=null).
  const showSpinner = loading && !data && !error;
  const listVisibleCount = Math.min(FLIGHT_LIST_VISIBLE, sortedFlights.length);
  /** Bla opp med fast vindu (15 rader); steg begrenset av avstand til toppen. */
  const pageEarlierStep = Math.min(FLIGHT_LIST_PAGE_STEP, windowStart);

  /**
   * Paging med utvidet radliste: nye rader er allerede rendret i stripen og avdekkes under gliden
   * (ikke først etter animasjon).
   */
  function runMobileListPanelPageSlide(
    kind: "later" | "earlier",
    nextWindow: { start: number; end: number },
    slideRows: number,
  ) {
    if (slideRows === 0) return;
    if (prefersReducedMotion()) {
      setListPanelTransformArmed(true);
      setWindowStart(nextWindow.start);
      setWindowEnd(nextWindow.end);
      return;
    }
    if (listPanelStrip !== null || listPanelSliding) return;

    const rowPx = flightRowHeightPx();

    if (kind === "later") {
      setListPanelTransformArmed(true);
      const flights = sortedFlights.slice(windowStart, windowEnd + slideRows);
      setListPanelStrip({ kind: "later", flights, nextWindow });
      setListPanelOffsetY(0);
      setListPanelSliding(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setListPanelOffsetY(-slideRows * rowPx);
        });
      });
      return;
    }

    const flights = sortedFlights.slice(nextWindow.start, windowEnd);
    setListPanelTransformArmed(false);
    setListPanelStrip({ kind: "earlier", flights, nextWindow });
    setListPanelOffsetY(-slideRows * rowPx);
    setListPanelSliding(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setListPanelTransformArmed(true);
        requestAnimationFrame(() => {
          setListPanelOffsetY(0);
        });
      });
    });
  }

  function onMobileListPanelTransitionEnd(e: TransitionEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.propertyName !== "transform") return;
    const strip = listPanelStripRef.current;
    if (!strip) return;
    setListPanelStrip(null);
    setListPanelSliding(false);
    setListPanelTransformArmed(true);
    setListPanelOffsetY(0);
    setWindowStart(strip.nextWindow.start);
    setWindowEnd(strip.nextWindow.end);
  }

  function handleEarlierPageClick(_ev?: MouseEvent<HTMLButtonElement> | null) {
    if (earlierExpandLoading || listPanelSliding) return;
    if (canPageEarlier) {
      // Krav: alltid "10 rader opp", unntatt når vi er helt på toppen av 24t-lista.
      // Hvis vi er nær toppen i 1t-lista (< 10 rader), kan vi ikke vise 10 nye uten å hente 24t,
      // så vi trigger utvidelsen her og lar pendingEarlier24h-logikken reposisjonere med nøyaktig 10.
      if (!showEarlier && pageEarlierStep < FLIGHT_LIST_PAGE_STEP) {
        const top = sortedFlights[windowStart];
        const bottom = windowEnd > windowStart ? sortedFlights[windowEnd - 1] : top;
        pendingEarlier24hRef.current = {
          topUid: top?.uniqueId ?? "",
          bottomUid: bottom?.uniqueId ?? "",
          visibleCount: listVisibleCount,
          airport,
          direction,
          listLenAtClick: sortedFlights.length,
          firstRowUidAtClick: sortedFlights[0]?.uniqueId ?? "",
        };
        setEarlierExpandLoading(true);
        setShowEarlier(true);
        return;
      }

      const n = sortedFlights.length;
      const preferred = Math.max(0, windowStart - pageEarlierStep);
      const w = fixedWindowFromPreferredStart(preferred, n);
      const shiftedBy = windowStart - w.start;
      runMobileListPanelPageSlide("earlier", { start: w.start, end: w.end }, shiftedBy);
      return;
    }
    if (canLoadEarlierApi) {
      const top = sortedFlights[windowStart];
      const bottom = windowEnd > windowStart ? sortedFlights[windowEnd - 1] : top;
      pendingEarlier24hRef.current = {
        topUid: top?.uniqueId ?? "",
        bottomUid: bottom?.uniqueId ?? "",
        visibleCount: listVisibleCount,
        airport,
        direction,
        listLenAtClick: sortedFlights.length,
        firstRowUidAtClick: sortedFlights[0]?.uniqueId ?? "",
      };
      setEarlierExpandLoading(true);
      setShowEarlier(true);
    }
  }

  function handleLaterPageClick(_ev?: MouseEvent<HTMLButtonElement> | null) {
    if (listPanelSliding) return;
    const n = sortedFlights.length;
    const slide = Math.min(FLIGHT_LIST_PAGE_STEP, n - windowEnd);
    if (slide <= 0) return;
    runMobileListPanelPageSlide(
      "later",
      { start: windowStart + slide, end: Math.min(n, windowEnd + slide) },
      slide,
    );
  }

  function isRecentPointerDown(): boolean {
    return Date.now() - navTapTsRef.current < 650;
  }

  function onNavTap(cb: () => void) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        navTapTsRef.current = Date.now();
        cb();
      },
      onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
        // Unngå dobbel firing på pointerdown + click (mus/touch/pen).
        // Tastaturaktivering gir typisk click uten pointerdown og skal fortsatt virke.
        if (isRecentPointerDown()) return;
        cb();
      },
    } as const;
  }

  function renderTime(f: Flight) {
    const schedule = fmtTime(f.scheduleTimeUtc);
    const scheduleRelativeDayLabel: string | null = (() => {
      const d = new Date(f.scheduleTimeUtc);
      if (Number.isNaN(d.getTime())) return null;
      const key = formatYmdOslo(d);
      if (key === yesterdayKey) return "i går";
      if (key === tomorrowKey) return "i morgen";
      return null;
    })();
    const newTime = f.statusTimeUtc ? fmtTime(f.statusTimeUtc) : "";
    const timeChanged = (() => {
      if (!f.statusTimeUtc) return false;
      if (useOriginalTimeOnlyForSmallUpcomingDeviation(f)) return false;
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

    if (scheduleRelativeDayLabel) {
      return (
        <>
          <span>{newTime}</span>
          <div className="text-[11px] font-semibold text-zinc-500 leading-tight">{scheduleRelativeDayLabel}</div>
        </>
      );
    }

    return (
      <>
        <span className="line-through opacity-70">{schedule}</span>
        <br />
        <span>{newTime}</span>
      </>
    );
  }

  const flightRowHeightStyle = {
    height: `${FLIGHT_LIST_ROW_HEIGHT_REM}rem`,
    minHeight: `${FLIGHT_LIST_ROW_HEIGHT_REM}rem`,
    maxHeight: `${FLIGHT_LIST_ROW_HEIGHT_REM}rem`,
  };

  return (
    <section className="w-full max-w-5xl overflow-x-hidden rounded-md border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-col gap-2 border-b border-zinc-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
            <h2 className="text-base font-semibold tracking-tight text-zinc-950">
              {airportLabels[airport] ?? airport}
            </h2>
          <p className="text-xs leading-snug text-zinc-600" suppressHydrationWarning>
            {loading && !data ? (
              <span className="text-zinc-500 animate-pulse">Oppdaterer…</span>
            ) : earlierExpandLoading ? (
              <span className="text-zinc-500 animate-pulse">Henter utvidet liste…</span>
            ) : data?.lastUpdateUtc ? (
              <span className="text-zinc-500">Sist oppdatert: {fmtTime(data.lastUpdateUtc)}</span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Kontrollpanel: alle knapper i én ramme, fast høyde og stabil alignment */}
          <div className="inline-flex max-w-full flex-wrap items-center rounded-md bg-zinc-100 p-0.5 ring-1 ring-zinc-200">
            <button
              type="button"
              role="tab"
              aria-label="Avganger"
              aria-selected={direction === "D"}
              onClick={() => {
                if (direction !== "D") {
                  pendingEarlier24hRef.current = null;
                  setListPanelStrip(null);
                  setListPanelSliding(false);
                  setListPanelTransformArmed(true);
                  setListPanelOffsetY(0);
                  setEarlierExpandLoading(false);
                  manualFetchRef.current = true;
                  setData(null);
                  setShowEarlier(false);
                  setDirection("D");
                }
              }}
              className={[
                "mx-px my-px inline-flex h-7 w-auto items-center justify-center box-border appearance-none px-[5px] py-0 text-xs font-semibold leading-none rounded-md border border-zinc-200/80 transition-colors duration-150 focus:outline-none",
                direction === "D"
                  ? "bg-white text-zinc-950 border-zinc-400 shadow-inner"
                  : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
              ].join(" ")}
            >
              Avganger
            </button>
            <button
              type="button"
              role="tab"
              aria-label="Ankomster"
              aria-selected={direction === "A"}
              onClick={() => {
                if (direction !== "A") {
                  pendingEarlier24hRef.current = null;
                  setListPanelStrip(null);
                  setListPanelSliding(false);
                  setListPanelTransformArmed(true);
                  setListPanelOffsetY(0);
                  setEarlierExpandLoading(false);
                  manualFetchRef.current = true;
                  setData(null);
                  setShowEarlier(false);
                  setDirection("A");
                }
              }}
              className={[
                "mx-px my-px inline-flex h-7 w-auto items-center justify-center box-border appearance-none px-[5px] py-0 text-xs font-semibold leading-none rounded-md border border-zinc-200/80 transition-colors duration-150 focus:outline-none",
                direction === "A"
                  ? "bg-white text-zinc-950 border-zinc-400 shadow-inner"
                  : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
              ].join(" ")}
            >
              Ankomster
            </button>

            <div className="mx-1 h-5 w-px bg-zinc-300/70" aria-hidden="true" />

            <div ref={airportMenuWrapRef} className="inline-flex flex-wrap items-center">
              {(["SVG", "BGO", "OSL"] as AirportCode[]).map((code) => (
                <button
                  key={code}
                  type="button"
                  role="tab"
                  aria-label={`Flyplass ${code}`}
                  aria-selected={airport === code}
                  onClick={() => {
                    if (airport !== code) {
                      pendingEarlier24hRef.current = null;
                      setListPanelStrip(null);
                      setListPanelSliding(false);
                      setListPanelTransformArmed(true);
                      setListPanelOffsetY(0);
                      setEarlierExpandLoading(false);
                      manualFetchRef.current = true;
                      setData(null);
                      setShowEarlier(false);
                      setAirport(code);
                    }
                  }}
                  className={[
                    "mx-px my-px inline-flex h-7 w-auto items-center justify-center box-border appearance-none px-1.5 py-0 text-xs font-semibold leading-none rounded-md border border-zinc-200/80 transition-colors duration-150 focus:outline-none",
                    airport === code
                      ? "bg-white text-zinc-950 border-zinc-400 shadow-inner"
                      : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
                  ].join(" ")}
                >
                  {code}
                </button>
              ))}

              <div className="relative">
                <button
                  ref={airportMenuButtonRef}
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={airportMenuOpen}
                  aria-label="Velg flyplass"
                  onClick={() => setAirportMenuOpen((x) => !x)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAirportMenuOpen(false);
                  }}
                  className={[
                    "mx-px my-px inline-flex h-7 w-7 items-center justify-center box-border appearance-none p-0 text-zinc-700 rounded-md border border-zinc-200/80 transition-colors duration-150 focus:outline-none",
                    airportMenuOpen
                      ? "bg-white text-zinc-950 border-zinc-400 shadow-inner"
                      : "text-zinc-600 hover:bg-white/70 hover:text-zinc-950",
                  ].join(" ")}
                >
                  <svg
                    className="block"
                    style={{ width: 12, height: 12 }}
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </button>

                {airportMenuOpen ? (
                  <div
                    ref={airportMenuRef}
                    role="listbox"
                    aria-label="Alle norske flyplasser"
                    className="fixed z-50 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg"
                    style={
                      airportMenuPos
                        ? { top: airportMenuPos.top, left: airportMenuPos.left, width: airportMenuPos.width }
                        : undefined
                    }
                  >
                    <div className="max-h-80 overflow-y-auto p-1">
                      {NORWEGIAN_AIRPORTS.map((a) => {
                        const selected = airport === a.code;
                        return (
                          <button
                            key={a.code}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              if (airport !== a.code) {
                                pendingEarlier24hRef.current = null;
                                setListPanelStrip(null);
                                setListPanelSliding(false);
                                setListPanelTransformArmed(true);
                                setListPanelOffsetY(0);
                                setEarlierExpandLoading(false);
                                manualFetchRef.current = true;
                                setData(null);
                                setShowEarlier(false);
                                setAirport(a.code);
                              }
                              setAirportMenuOpen(false);
                            }}
                            className={[
                              "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold",
                              selected ? "bg-sky-50 text-sky-900" : "text-zinc-700 hover:bg-zinc-50",
                            ].join(" ")}
                          >
                            <span className="min-w-0 whitespace-normal break-words leading-snug">{a.name}</span>
                            <span className="shrink-0 text-[11px] text-zinc-500">{a.code}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
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
              {sortedFlights.length > 0 ? (
                <div className="-mx-4 border-b border-zinc-100 bg-zinc-50/50 py-0">
                  <button
                    type="button"
                    aria-busy={earlierExpandLoading}
                    disabled={earlierNavDisabled}
                    aria-label={
                      earlierExpandLoading
                        ? "Laster utvidet liste"
                        : earlierNavDisabled
                          ? direction === "D"
                            ? "Ingen flere tidligere avganger å vise"
                            : "Ingen flere tidligere ankomster å vise"
                          : canPageEarlier
                            ? `Vis ${pageEarlierStep} tidligere fly`
                            : direction === "D"
                              ? "Last inn tidligere avganger"
                              : "Last inn tidligere ankomster"
                    }
                    {...onNavTap(() => handleEarlierPageClick(null))}
                    className={LIST_SCROLL_NAV_BUTTON_CLASS}
                  >
                    {earlierExpandLoading ? (
                      <svg
                        className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500"
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
                    ) : (
                      <svg
                        className="h-3.5 w-3.5 shrink-0"
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
                    )}
                    <span className="text-xs font-semibold leading-none">
                      {earlierExpandLoading ? "laster…" : "tidligere fly"}
                    </span>
                  </button>
                </div>
              ) : null}
              {sortedFlights.length === 0 ? (
                <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                  Ingen fly i dette tidsrommet.
                </div>
              ) : (
                <div
                  className="overflow-hidden"
                  style={{
                    height: `${mobilePanelVisibleRows * FLIGHT_LIST_ROW_HEIGHT_REM}rem`,
                  }}
                >
                  <div
                    className="flex flex-col"
                    ref={mobileListPanelRef}
                    onTransitionEnd={onMobileListPanelTransitionEnd}
                    style={{
                      transform: `translate3d(0, ${listPanelOffsetY}px, 0)`,
                      transition:
                        listPanelSliding && listPanelTransformArmed
                          ? `transform ${FLIGHT_LIST_PANEL_SLIDE_MS}ms ${FLIGHT_LIST_PANEL_SLIDE_EASING}`
                          : "none",
                      willChange:
                        listPanelSliding && listPanelTransformArmed ? "transform" : undefined,
                    }}
                  >
                {mobileListFlights.map((f) => {
              const status = effectiveStatus(f, clientNowMs);
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
                  style={{
                    ...flightRowHeightStyle,
                    gridTemplateColumns: `${FLIGHT_LIST_TIME_COL} minmax(0, 1fr) auto`,
                  }}
                  className={`grid shrink-0 items-center gap-x-1.5 overflow-hidden border-b border-zinc-200 box-border px-2.5 py-0.5 ${
                    updatedUids.has(f.uniqueId) ? "updated-row" : ""
                  } ${isCancelled ? "text-red-700" : ""}`}
                >
                  <div
                    className={`line-clamp-2 min-h-0 min-w-0 overflow-hidden text-sm font-semibold tabular-nums leading-tight ${
                      isCancelled ? "text-red-700" : "text-zinc-950"
                    }`}
                  >
                    {renderTime(f)}
                  </div>
                  <div className="flex min-h-0 min-w-0 flex-col justify-center gap-px overflow-hidden self-stretch">
                    <div
                      className={`truncate text-sm font-semibold leading-tight ${isCancelled ? "text-red-700" : "text-zinc-950"}`}
                    >
                      {placeName}
                    </div>
                    <div className={`truncate text-[11px] font-semibold leading-tight ${isCancelled ? "text-red-700" : "text-zinc-700"}`}>
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

                <div className="flex h-full min-h-0 items-center justify-end">
                  {mobileStatusLabel !== "Scheduled" ? (
                    <span
                      className={[
                        "inline-flex max-h-8 shrink-0 items-center rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-inset whitespace-nowrap leading-snug",
                        statusClass(status),
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
                })}
                  </div>
                </div>
              )}
            </>
          )}

          {sortedFlights.length > 0 ? (
            <div className="-mx-4 border-t border-zinc-100 bg-zinc-50/50 py-0">
              <button
                type="button"
                aria-label={
                  laterNavDisabled
                    ? "Ingen flere senere fly å vise"
                    : `Vis ${Math.min(FLIGHT_LIST_PAGE_STEP, sortedFlights.length - windowEnd)} senere fly`
                }
                disabled={laterNavDisabled}
                {...onNavTap(() => handleLaterPageClick(null))}
                className={LIST_SCROLL_NAV_BUTTON_CLASS}
              >
                <svg
                  className="h-3.5 w-3.5 shrink-0"
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
                <span className="text-xs font-semibold leading-none">senere fly</span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto">
          <table className="min-w-[900px] w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="w-[3.25rem] max-w-[3.25rem] py-1.5 pr-2 whitespace-nowrap">Tid</th>
                <th className="py-1.5 pr-4">{direction === "D" ? "Til" : "Fra"}</th>
                <th className="py-1.5 pr-4">Fly</th>
                <th className="py-1.5 pr-4">Status</th>
                <th className="py-1.5 pr-4">Gate</th>
                <th className="py-1.5 pr-4">Bånd</th>
              </tr>
            </thead>
            <tbody className="text-zinc-950">
              {showSpinner ? (
                <tr>
                  <td colSpan={6} className="py-4 text-zinc-600">
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
                  <td colSpan={6} className="py-4 text-zinc-600">
                    Ingen fly i dette tidsrommet.
                  </td>
                </tr>
              ) : (
                displayedFlights.map((f) => {
                  const status = effectiveStatus(f, clientNowMs);
                  const isCancelled = status.code === "C";
                  return (
                    <tr
                      key={f.uniqueId}
                      className={`border-b border-zinc-100 last:border-b-0 ${updatedUids.has(f.uniqueId) ? "updated-row" : ""} ${
                        isCancelled ? "text-red-700" : ""
                      }`}
                    >
                      <td
                        style={flightRowHeightStyle}
                        className="box-border w-[3.25rem] max-w-[3.25rem] overflow-hidden align-middle py-0.5 pr-2"
                      >
                        <div
                          className={`line-clamp-2 text-sm font-medium tabular-nums leading-tight ${isCancelled ? "text-red-700" : "text-zinc-950"}`}
                        >
                          {renderTime(f)}
                        </div>
                      </td>
                      <td
                        style={flightRowHeightStyle}
                        className="box-border overflow-hidden align-middle py-0.5 pr-4"
                      >
                        <div className={`truncate text-sm leading-tight ${isCancelled ? "text-red-700" : ""}`}>
                          {f.airportName ?? f.airport}
                        </div>
                      </td>
                      <td
                        style={flightRowHeightStyle}
                        className="box-border overflow-hidden align-middle py-0.5 pr-4"
                      >
                        <div className="truncate text-sm leading-tight">
                          {f.flightId}
                          <span className="mx-2 text-zinc-400">|</span>
                          {f.airlineName ?? f.airline}
                        </div>
                      </td>
                      <td
                        style={flightRowHeightStyle}
                        className="box-border overflow-hidden align-middle py-0.5 pr-4"
                      >
                        {status.label !== "Scheduled" ? (
                          <span
                            className={[
                              "inline-flex max-h-8 items-center rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-inset leading-snug",
                              statusClass(status),
                            ].join(" ")}
                          >
                            {status.label}
                          </span>
                        ) : null}
                      </td>
                      <td
                        style={flightRowHeightStyle}
                        className="box-border overflow-hidden align-middle py-0.5 pr-4"
                      >
                        <div className="truncate text-sm text-zinc-700 leading-tight">{f.gate && f.gate !== "—" ? f.gate : ""}</div>
                      </td>
                      <td
                        style={flightRowHeightStyle}
                        className="box-border overflow-hidden align-middle py-0.5 pr-4"
                      >
                        <div className="truncate text-sm text-zinc-700 leading-tight">
                          {f.beltNumber && f.beltNumber !== "—" ? f.beltNumber : ""}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>

          {sortedFlights.length > 0 ? (
            <div className="-mx-4 border-t border-zinc-100 bg-zinc-50/50 py-0">
              <button
                type="button"
                aria-label={
                  laterNavDisabled
                    ? "Ingen flere senere fly å vise"
                    : `Vis ${Math.min(FLIGHT_LIST_PAGE_STEP, sortedFlights.length - windowEnd)} senere fly`
                }
                disabled={laterNavDisabled}
                onClick={handleLaterPageClick}
                className={LIST_SCROLL_NAV_BUTTON_CLASS}
              >
                <svg
                  className="h-3.5 w-3.5 shrink-0"
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
                <span className="text-xs font-semibold leading-none">senere fly</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-3 text-[11px] text-zinc-500">
          
          ©{" "}
          <a className="underline hover:text-zinc-700" href="https://www.aftenbladet.no" target="_blank" rel="noreferrer">
            Aftenbladet.no
          </a> 
          {"/MS | "}Data:{" "}
          <a className="underline hover:text-zinc-700" href="https://www.avinor.no" target="_blank" rel="noreferrer">
            Avinor
          </a>
        </div>
      </div>
    </section>
  );
}

