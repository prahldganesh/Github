/**
 * Admin loading state.
 *
 * Lives inside the `(dashboard)` group so it applies to every admin page. The
 * header and nav come from the layout and stay put; only the content area shows
 * the skeleton.
 */
export default function AdminLoading() {
  return (
    <div>
      <div className="h-8 w-48 animate-pulse rounded bg-slate-200" />
      <div className="mt-8 space-y-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-12 animate-pulse rounded bg-slate-100" />
        ))}
      </div>
    </div>
  );
}
