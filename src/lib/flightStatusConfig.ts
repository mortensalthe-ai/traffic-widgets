export type FlightForStatus = {
  scheduleTimeUtc: string;
  statusCode?: string;
  statusTextNo?: string;
  statusTimeUtc?: string;
};

export type EffectiveStatus = { code?: string; label: string; showStatusTime: boolean };

/** «Ny tid»-status bare når avvik er større enn dette og ny tid er i fremtiden. */
export const UPCOMING_NY_TID_DEVIATION_MS = 15 * 60 * 1000;
/** For ikke-D/A: vis kun planlagt tid (ingen strek/ekstra linje) når avvik er høyst dette. */
export const UPCOMING_SCHEDULE_ONLY_MAX_DEVIATION_MS = 5 * 60 * 1000;
/** Ny tid mer enn dette etter planlagt → statusetikett «Forsinket» (kun ikke-fullførte fly). */
export const FORSINKET_ETTER_PLAN_MS = 30 * 60 * 1000;
/** Skjul «Ny tid»/«Forsinket» når både planlagt og ny tid er langt fram i tid. */
export const FAR_FUTURE_STATUS_PILL_CUTOFF_MS = 2.5 * 60 * 60 * 1000;

export function isDepartedOrArrived(flight: FlightForStatus): boolean {
  return flight.statusCode === "D" || flight.statusCode === "A";
}

/** Ikke avgått/ankommet, avvik høyst 5 min → vis kun planlagt tid i tidskolonnen. */
export function useOriginalTimeOnlyForSmallUpcomingDeviation(flight: FlightForStatus): boolean {
  if (!flight.statusTimeUtc || !flight.scheduleTimeUtc) return false;
  if (isDepartedOrArrived(flight)) return false;
  const oldMs = Date.parse(flight.scheduleTimeUtc);
  const newMs = Date.parse(flight.statusTimeUtc);
  if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) return false;
  return Math.abs(newMs - oldMs) <= UPCOMING_SCHEDULE_ONLY_MAX_DEVIATION_MS;
}

export function statusLabel(code?: string): string {
  if (!code) return "Scheduled";
  if (code === "A") return "Ankommet";
  if (code === "C") return "Kansellert";
  if (code === "D") return "Avgått";
  if (code === "E") return "Ny tid";
  if (code === "N") return "Ny info";
  return code;
}

export function effectiveStatus(
  flight: FlightForStatus,
  /** null før hydrate — unngår Date.now()-forskjell mellom server og klient. */
  nowMs: number | null,
): EffectiveStatus {
  const code = flight.statusCode;
  if (code === "E" && flight.statusTimeUtc && flight.scheduleTimeUtc) {
    const oldMs = Date.parse(flight.scheduleTimeUtc);
    const newMs = Date.parse(flight.statusTimeUtc);

    if (Number.isFinite(oldMs) && Number.isFinite(newMs)) {
      const deviationMs = Math.abs(newMs - oldMs);
      const newInFuture = nowMs !== null && newMs > nowMs;
      const farFutureCutoffMs = nowMs !== null ? nowMs + FAR_FUTURE_STATUS_PILL_CUTOFF_MS : null;
      const bothFarInFuture =
        farFutureCutoffMs !== null && oldMs > farFutureCutoffMs && newMs > farFutureCutoffMs;

      if (!isDepartedOrArrived(flight) && newMs > oldMs + FORSINKET_ETTER_PLAN_MS) {
        if (bothFarInFuture) return { code: undefined, label: "Scheduled", showStatusTime: false };
        return { code: "E", label: "Forsinket", showStatusTime: false };
      }

      const showNyTid = newInFuture && deviationMs > UPCOMING_NY_TID_DEVIATION_MS;
      if (showNyTid) {
        if (bothFarInFuture) return { code: undefined, label: "Scheduled", showStatusTime: false };
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

export function statusClass(status: { code?: string; label: string }): string {
  const { code, label } = status;
  if (code === "C") return "bg-red-50 text-red-700 ring-red-200";
  // Blue-ish “positive” styling to better match the examples.
  if (code === "D" || code === "A") return "bg-sky-50 text-sky-700 ring-sky-200";
  if (label === "Ny tid") return "bg-amber-50 text-amber-800 ring-amber-200";
  if (label === "Forsinket") return "bg-orange-100/60 text-red-800 ring-orange-300/50";
  if (code === "E" || code === "N") return "bg-orange-50 text-orange-900 ring-orange-200";
  return "bg-zinc-50 text-zinc-700 ring-zinc-200";
}
