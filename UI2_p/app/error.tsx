"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f2eb] p-6 text-[#0d2f3f]">
      <section className="max-w-md border-[3px] border-[#0d2f3f] bg-white p-6 shadow-[8px_8px_0_#0d2f3f]">
        <p className="mb-2 text-xs font-black uppercase tracking-[0.2em]">
          SAOS stopped safely
        </p>
        <h1 className="font-display text-3xl font-black">
          The local screen hit an error.
        </h1>
        <p className="mt-3 text-sm leading-6">
          Your saved records are still on this device. Try the screen again; no
          ServiceNow write was attempted.
        </p>
        <button
          className="mt-5 border-2 border-[#0d2f3f] bg-[#5edc56] px-4 py-3 text-sm font-black"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
