/**
 * Product image upload.
 *
 * POST /api/admin/products/image  (multipart/form-data, field `file`)
 *
 * WHY SERVER-SIDE AND NOT A PRESIGNED BROWSER UPLOAD. Supabase Storage supports
 * direct browser uploads with a presigned URL, which is the better pattern for
 * large files at scale. It is deliberately NOT used here, because it would mean
 * handing the browser a storage credential (or a signing endpoint that is almost
 * as good) for a feature used by one admin uploading a small product photo. The
 * file passes through this route, is validated, and only then reaches storage -
 * which also means the validation cannot be skipped by a client that ignores it.
 *
 * CREDENTIALS. `SUPABASE_SERVICE_ROLE_KEY` is read on the server and is never
 * sent to the browser. It is used only to write to the public product-images
 * bucket.
 *
 * FAILURE IS EXPLICIT. If storage is not configured, this returns 503 rather
 * than pretending - and the product form's existing paste-a-URL field still
 * works, so the deployment never depends on this route existing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { assertAdmin } from "@/lib/auth/guard";
import { rateLimit } from "@/lib/rate-limit";
import { logger, errorFields } from "@/lib/logger";
import {
  messageForUploadProblem,
  objectNameFor,
  validateImageUpload,
} from "@/lib/products/upload-rules";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function storageConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      process.env.SUPABASE_STORAGE_BUCKET,
  );
}

export async function POST(request: NextRequest) {
  // Authorization first. Uploading writes to a public bucket, so it is
  // admin-only, checked on the server.
  try {
    await assertAdmin();
  } catch {
    return NextResponse.json({ error: "Not authorised" }, { status: 401 });
  }

  // An upload is expensive and writes to shared storage, so it is rate limited.
  const limit = await rateLimit(request, { key: "product-image-upload", limit: 20, windowMs: 60_000 });
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many uploads. Please wait a moment." },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  if (!storageConfigured()) {
    return NextResponse.json(
      {
        error:
          "Image storage is not configured. You can still paste an image URL instead.",
      },
      { status: 503 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was provided." }, { status: 400 });
  }

  // `file.size` is authoritative here - the body is already buffered by
  // `formData()`. The rule is applied before anything is read into memory for
  // upload.
  const validation = validateImageUpload({
    mime: file.type,
    size: file.size,
    filename: file.name,
  });
  if (!validation.ok) {
    return NextResponse.json(
      { error: messageForUploadProblem(validation.problem), code: validation.problem.kind },
      { status: 400 },
    );
  }

  // The object name is GENERATED, never taken from the upload. See
  // `upload-rules.ts` for why.
  const objectName = objectNameFor(validation.mime, crypto.randomUUID());
  const bucket = process.env.SUPABASE_STORAGE_BUCKET!;
  const baseUrl = process.env.SUPABASE_URL!.replace(/\/+$/, "");

  try {
    const bytes = await file.arrayBuffer();

    const uploadResponse = await fetch(
      `${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectName}`,
      {
        method: "POST",
        headers: {
          // Service-role key: server-side only, never in a response.
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": validation.mime,
          "x-upsert": "false",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
        body: bytes,
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => "");
      logger.error("product image upload rejected by storage", {
        status: uploadResponse.status,
        detail: detail.slice(0, 300),
      });
      return NextResponse.json({ error: "Could not store the image." }, { status: 502 });
    }

    // The PUBLIC url for the stored object. Built from the bucket and the name
    // we generated, so it can only ever point at what we just stored.
    const publicUrl = `${baseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectName}`;

    logger.info("product image stored", {
      objectName,
      bytes: validation.bytes,
      mime: validation.mime,
    });

    return NextResponse.json({ url: publicUrl, objectName }, { status: 201 });
  } catch (error) {
    logger.error("product image upload failed", errorFields(error));
    return NextResponse.json({ error: "Could not upload the image." }, { status: 502 });
  }
}
