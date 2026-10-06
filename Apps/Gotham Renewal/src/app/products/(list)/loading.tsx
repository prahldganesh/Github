/**
 * Catalogue loading state.
 *
 * A Server Component Suspense fallback: Next renders this while the catalogue
 * query is in flight, instead of a blank screen. A skeleton rather than a
 * spinner keeps the layout from jumping when the real content arrives.
 */
export default function ProductsLoading() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="h-9 w-40 animate-pulse rounded bg-slate-200" />
      <div className="mt-3 h-5 w-56 animate-pulse rounded bg-slate-100" />
      <ul className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <li key={index} className="rounded-lg border border-slate-200">
            <div className="aspect-square animate-pulse rounded-t-lg bg-slate-100" />
            <div className="space-y-2 p-4">
              <div className="h-4 w-3/4 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-1/3 animate-pulse rounded bg-slate-100" />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
