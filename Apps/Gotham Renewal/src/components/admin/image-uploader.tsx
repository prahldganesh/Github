"use client";

/**
 * Product image upload.
 *
 * A Client Component because it needs browser state (the chosen file, the upload
 * progress, the resulting URL). It is a CONVENIENCE, not a control: the route it
 * calls re-checks authorization and re-validates the file on the server, and the
 * storage credential never reaches this code.
 *
 * On success it writes the returned public URL into the product form's
 * `imageUrl` field, so the form still submits a plain URL and the database keeps
 * a single, storage-agnostic reference. The upload is therefore additive: a
 * deployment without storage configured simply shows the error and the admin
 * pastes a URL instead.
 */
import { useRef, useState } from "react";

const MAX_BYTES = 5 * 1024 * 1024;

export function ImageUploader({ targetInputId }: { targetInputId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);

    // A cheap client-side pre-check for a nicer message. The server checks
    // again - this is not the control.
    if (file.size > MAX_BYTES) {
      setError("That image is too large. The maximum is 5 MB.");
      setBusy(false);
      return;
    }

    try {
      const body = new FormData();
      body.append("file", file);

      const response = await fetch("/api/admin/products/image", { method: "POST", body });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };

      if (!response.ok || !data.url) {
        setError(data.error ?? "The upload failed. You can paste an image URL instead.");
        setBusy(false);
        return;
      }

      // Put the resulting URL into the product form so it is submitted normally.
      const target = document.getElementById(targetInputId) as HTMLInputElement | null;
      if (target) {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(target, data.url);
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setUploadedUrl(data.url);
    } catch {
      setError("The upload failed. Check your connection, or paste an image URL instead.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <label className="text-sm font-medium text-slate-700">Upload an image (optional)</label>
      <p className="mt-1 text-xs text-slate-500">
        JPEG, PNG, WebP or GIF, up to 5 MB. The resulting URL is filled into the
        field above.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
        className="mt-2 block w-full text-sm text-slate-700"
      />

      {busy && <p className="mt-2 text-sm text-slate-600">Uploading…</p>}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {uploadedUrl && (
        <p className="mt-2 text-sm text-green-800">
          Uploaded. The image URL field now points at the new file.
        </p>
      )}
    </div>
  );
}
