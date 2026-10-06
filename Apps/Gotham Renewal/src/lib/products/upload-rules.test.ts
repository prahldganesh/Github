/**
 * Upload-rule tests.
 *
 * These are security rules, so the cases that matter are the hostile ones: a
 * script disguised as an image, a mismatched extension, an oversized file, and a
 * filename that tries to escape its directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_BYTES,
  extensionOf,
  objectNameFor,
  validateImageUpload,
} from "./upload-rules";

test("accepts the four raster image formats", () => {
  const cases = [
    { mime: "image/jpeg", filename: "a.jpg", ext: "jpg" },
    { mime: "image/jpeg", filename: "a.jpeg", ext: "jpg" },
    { mime: "image/png", filename: "a.png", ext: "png" },
    { mime: "image/webp", filename: "a.webp", ext: "webp" },
    { mime: "image/gif", filename: "a.gif", ext: "gif" },
  ];
  for (const { mime, filename, ext } of cases) {
    const result = validateImageUpload({ mime, size: 1024, filename });
    assert.ok(result.ok, `${mime} / ${filename} should be accepted`);
    if (result.ok) assert.equal(result.extension, ext);
  }
});

test("is case-insensitive about the declared type", () => {
  const result = validateImageUpload({ mime: "IMAGE/PNG", size: 10, filename: "x.PNG" });
  assert.ok(result.ok);
});

test("refuses non-image types, including ones that can carry script", () => {
  for (const mime of [
    "text/html",
    "application/javascript",
    "image/svg+xml", // SVG can contain script - deliberately excluded
    "application/pdf",
    "application/x-php",
    "application/octet-stream",
    "",
  ]) {
    const result = validateImageUpload({ mime, size: 100, filename: "x.png" });
    assert.ok(!result.ok, `${mime} should be refused`);
    if (!result.ok) assert.equal(result.problem.kind, "unsupported-type");
  }
});

test("refuses when the extension disagrees with the declared type", () => {
  // An HTML file claiming to be a JPEG.
  const a = validateImageUpload({ mime: "image/jpeg", size: 100, filename: "evil.html" });
  assert.ok(!a.ok);
  if (!a.ok) assert.equal(a.problem.kind, "filename-extension-mismatch");

  // A JPEG claiming to be HTML - the mismatch is refused whichever way it runs.
  const b = validateImageUpload({ mime: "text/html", size: 100, filename: "evil.jpg" });
  assert.ok(!b.ok);

  // A PHP file renamed to look like an image extension is refused because the
  // extension does not match the image MIME.
  const c = validateImageUpload({ mime: "image/png", size: 100, filename: "shell.php" });
  assert.ok(!c.ok);
});

test("refuses a file with no extension", () => {
  const result = validateImageUpload({ mime: "image/png", size: 100, filename: "noext" });
  assert.ok(!result.ok);
});

test("enforces the size ceiling at the boundary", () => {
  const atLimit = validateImageUpload({
    mime: "image/png",
    size: MAX_IMAGE_BYTES,
    filename: "big.png",
  });
  assert.ok(atLimit.ok, "exactly at the limit is allowed");

  const overLimit = validateImageUpload({
    mime: "image/png",
    size: MAX_IMAGE_BYTES + 1,
    filename: "big.png",
  });
  assert.ok(!overLimit.ok);
  if (!overLimit.ok) assert.equal(overLimit.problem.kind, "too-large");
});

test("refuses an empty file", () => {
  const result = validateImageUpload({ mime: "image/png", size: 0, filename: "empty.png" });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.problem.kind, "empty");
});

test("extensionOf reads the final extension only", () => {
  assert.equal(extensionOf("photo.jpg"), "jpg");
  assert.equal(extensionOf("photo.JPG"), "jpg");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf("noext"), "");
  assert.equal(extensionOf("dots."), "");
});

test("the object name ignores the uploaded filename entirely", () => {
  // This is the path-traversal defence: a hostile name must not reach storage.
  const hostile = "../../etc/passwd.jpg";
  const name = objectNameFor("image/jpeg", "11111111-2222-3333-4444-555555555555");

  assert.equal(name, "products/11111111-2222-3333-4444-555555555555.jpg");
  assert.ok(!name.includes(".."), "no traversal in the generated name");
  // The generated name is derived only from the id and the validated mime.
  assert.ok(!name.includes("passwd"));
  assert.ok(!name.includes(hostile));
});

test("the object name always uses the canonical extension for the type", () => {
  assert.equal(objectNameFor("image/jpeg", "id").endsWith(".jpg"), true);
  assert.equal(objectNameFor("image/png", "id").endsWith(".png"), true);
});

test("no combination of inputs throws", () => {
  const junk = ["", " ", "..", "/", "a".repeat(500), "photo.JPG.exe", "%2e%2e/a.png"];
  for (const filename of junk) {
    for (const mime of ["image/png", "text/html", ""]) {
      assert.doesNotThrow(
        () => validateImageUpload({ mime, size: 100, filename }),
        `threw on ${mime} / ${filename}`,
      );
    }
  }
});
