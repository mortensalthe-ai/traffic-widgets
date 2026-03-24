"use client";

import { useState } from "react";

export function CopyKolumbusHtmlButton() {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");

  async function onCopy() {
    setState("copying");
    try {
      const res = await fetch("/kolumbus-widget.html", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      await navigator.clipboard.writeText(html);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 2400);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onCopy}
        disabled={state === "copying"}
        aria-busy={state === "copying"}
        className="h-9 rounded-md border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-950 hover:bg-zinc-50 disabled:opacity-60"
      >
        {state === "copying" ? "Kopierer..." : "Kopier Kolumbus-HTML"}
      </button>
      <span className="text-xs text-zinc-500">
        {state === "copied"
          ? "Kopierte hele den frittstående Kolumbus-widgeten."
          : state === "error"
            ? "Kunne ikke kopiere. Sjekk nettleserens tilgang til utklippstavlen."
            : "Kopierer all kode som trengs for innliming i en side."}
      </span>
    </div>
  );
}

