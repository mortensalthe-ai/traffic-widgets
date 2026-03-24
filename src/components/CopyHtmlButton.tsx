"use client";

import { useState } from "react";

export function CopyHtmlButton() {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");

  async function onCopy() {
    setState("copying");
    try {
      const res = await fetch("/trafikken-widget.html", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to load HTML (${res.status})`);
      }

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
        {state === "copying" ? (
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
            Kopierer...
          </span>
        ) : (
          "Kopier HTML"
        )}
      </button>
      <span className="text-xs text-zinc-500">
        {state === "copied"
          ? "Kopierte hele den frittstående widget-HTML-en."
          : state === "error"
            ? "Kunne ikke kopiere. Sjekk nettleserens tilgang til utklippstavlen."
            : "Kopierer all kode som trengs for innliming i en side."}
      </span>
    </div>
  );
}

