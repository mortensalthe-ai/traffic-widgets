"use client";

import dynamic from "next/dynamic";

const FlightWidget = dynamic(() => import("@/components/FlightWidget").then((m) => m.FlightWidget), {
  ssr: false,
});

export default function AvinorPage() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-6 font-sans text-zinc-950">
      <FlightWidget />
    </div>
  );
}
