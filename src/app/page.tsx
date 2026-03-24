import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center bg-zinc-50 px-6 py-10 font-sans text-zinc-950">
      <main className="flex w-full max-w-5xl flex-1 flex-col gap-6">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">Trafikken</h1>
          <p className="mt-1 text-zinc-600">Velg hvilken widget du vil bruke.</p>
        </header>

        <section className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/avinor"
            className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md"
          >
            <h2 className="text-lg font-semibold tracking-tight">Avinor</h2>
            <p className="mt-1 text-sm text-zinc-600">Flystatus for avganger og ankomster.</p>
          </Link>

          <Link
            href="/kolumbus"
            className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-px hover:shadow-md"
          >
            <h2 className="text-lg font-semibold tracking-tight">Kolumbus</h2>
            <p className="mt-1 text-sm text-zinc-600">Driftsmeldinger og trafikkendringer.</p>
          </Link>
        </section>
      </main>
    </div>
  );
}
