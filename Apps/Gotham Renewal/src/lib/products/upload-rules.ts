/**
 * Upload validation - the pure rules.
 *
 * Separate from the upload itself so the security rules are testable without a
 * storage provider or credentials. Everything here is a function of its input.
 *
 * The threats being closed:
 *
 *   - **Arbitrary executable upload.** An uploaded `.php`, `.js`, `.html` or
 *     `.svg` (which can carry script) served from a public URL is a stored-XSS
 *     or worse. Only raster image types are allowed, by MIME AND by extension -
 *     the MIME a browser sends is attacker-controlled, so it cannot be the only
 *     check.
 *   - **Oversized uploads.** A size ceiling protects the storage quota and
 *     memory.
 *   - **Path traversal / hostile object names.** The object name is GENERATED,
 *     never taken from the uploaded filename. A filename like
 *     `../../etc/passwd` or `a" onload="` never reaches the storage provider,
 *     because it is not used at all.
 */

/** Formats a browser can render directly and that cannot carry script. */
export const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export type AllowedImageMime = keyof typeof ALLOWED_IMAGE_TYPES;

/** 5 MB. Generous for a product photo, small enough to bound memory. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type UploadValidationProblem =
  | { kind: "too-large"; maxBytes: number }
  | { kind: "unsupported-type"; received: string }
  | { kind: "empty" }
  | { kind: "filename-extension-mismatch" };

export type UploadValidation =
  | { ok: true; mime: AllowedImageMime; extension: string; bytes: number }
  | { ok: false; problem: UploadValidationProblem };

/** The lowercase extension of a filename, without the dot. */
export function extensionOf(filename: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Validate an upload's declared type, size, and filename extension.
 *
 * Note the extension check: a file named `photo.jpg` whose declared type is
 * `text/html` is refused, and so is `photo.html` declared as `image/jpeg`. Both
 * must agree, and both must be in the allow-list, so neither the header nor the
 * name alone can smuggle a non-image through.
 */
export function validateImageUpload(input: {
  mime: string;
  size: number;
  filename: string;
}): UploadValidation {
  if (input.size <= 0) return { ok: false, problem: { kind: "empty" } };
  if (input.size > MAX_IMAGE_BYTES) {
    return { ok: false, problem: { kind: "too-large", maxBytes: MAX_IMAGE_BYTES } };
  }

  const mime = input.mime.toLowerCase().trim();
  if (!(mime in ALLOWED_IMAGE_TYPES)) {
    return { ok: false, problem: { kind: "unsupported-type", received: input.mime } };
  }

  const allowedExtension = ALLOWED_IMAGE_TYPES[mime as AllowedImageMime];
  const provided = extensionOf(input.filename);
  // `jpeg` and `jpg` are the same format; accept either spelling for jpeg.
  const acceptable =
    provided === allowedExtension || (allowedExtension === "jpg" && provided === "jpeg");
  if (!acceptable) {
    return { ok: false, problem: { kind: "filename-extension-mismatch" } };
  }

  return { ok: true, mime: mime as AllowedImageMime, extension: allowedExtension, bytes: input.size };
}

/**
 * Build the object name to store.
 *
 * GENERATED, not derived from the uploaded filename. Even though the extension
 * has been validated, the rest of an attacker-supplied name is not worth the
 * risk of carrying into a storage path - and a random name also avoids two
 * uploads colliding.
 *
 * `crypto.randomUUID()` comes from the runtime; the leading prefix keeps objects
 * grouped and identifiable in the bucket.
 */
export function objectNameFor(mime: AllowedImageMime, randomId: string): string {
  return `products/${randomId}.${ALLOWED_IMAGE_TYPES[mime]}`;
}

/** A client-safe message for a validation problem. */
export function messageForUploadProblem(problem: UploadValidationProblem): string {
  switch (problem.kind) {
    case "empty":
      return "The file is empty.";
    case "too-large":
      return `That image is too large. The maximum is ${Math.floor(problem.maxBytes / 1024 / 1024)} MB.`;
    case "unsupported-type":
      return "Only JPEG, PNG, WebP and GIF images are supported.";
    case "filename-extension-mismatch":
      return "The file's name and its actual type do not match. Rename it or re-export it and try again.";
  }
}
