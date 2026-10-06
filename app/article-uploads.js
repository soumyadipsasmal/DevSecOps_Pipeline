"use strict";

/**
 * KaliNova — banner image uploads
 *
 * Uploads arrive as a raw image body (POST /api/admin/uploads with the file as
 * the request body), which avoids a multipart dependency and lets the browser
 * stream a File straight to the server.
 *
 * Trust decisions:
 *   - The declared Content-Type is never trusted. The format is decided by
 *     reading the file's magic bytes.
 *   - The submitted filename is never used. A random name is generated, so
 *     "shell.php" cannot become a path and no extension is attacker-controlled.
 *   - Only JPEG, PNG, WebP and AVIF are accepted. SVG and anything executable
 *     (PHP, JS, HTML) is rejected, so a stored file can only ever be an image.
 *   - Files are written inside frontend/assets/uploads and served as static
 *     assets, matching the existing /assets/topics/<topic>/<nn>.jpg convention.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const config = require("./config");

const UPLOAD_DIR = path.join(__dirname, "..", "frontend", "assets", "uploads");
const UPLOAD_PUBLIC_PREFIX = "/assets/uploads/";

/* Signature -> canonical extension. The extension always comes from here, so a
 * file can never be stored with an extension its contents do not support. */
const SIGNATURES = [
  {
    name: "jpeg",
    extension: "jpg",
    test: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  },
  {
    name: "png",
    extension: "png",
    test: buffer =>
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
  },
  {
    name: "webp",
    extension: "webp",
    test: buffer =>
      buffer.length >= 12 &&
      buffer.slice(0, 4).toString("ascii") === "RIFF" &&
      buffer.slice(8, 12).toString("ascii") === "WEBP"
  },
  {
    name: "avif",
    extension: "avif",
    test: buffer => {
      if (buffer.length < 12) return false;
      if (buffer.slice(4, 8).toString("ascii") !== "ftyp") return false;

      const box = buffer.slice(8, Math.min(buffer.length, 8 + 64)).toString("ascii");
      return box.includes("avif") || box.includes("avis");
    }
  }
];

/**
 * Identify an image by its contents.
 * @returns {{ name: string, extension: string } | null} null for anything that
 *   is not one of the four permitted formats.
 */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  for (const signature of SIGNATURES) {
    try {
      if (signature.test(buffer)) {
        return { name: signature.name, extension: signature.extension };
      }
    } catch {
      // A truncated buffer simply does not match.
    }
  }

  return null;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Validate and store an uploaded banner.
 *
 * @param {Buffer} buffer raw request body
 * @param {{ declaredType?: string, declaredName?: string }} [meta] kept only for error messages
 * @returns {Promise<{ path: string, bytes: number, type: string, fileName: string }>}
 * @throws {Error} with a `code` of EMPTY_FILE, FILE_TOO_LARGE or UNSUPPORTED_IMAGE_TYPE
 */
async function storeBannerImage(buffer, meta = {}) {
  const maxBytes = config.uploadMaxBytes;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error("No image was received. Choose a file and try again.");
    error.code = "EMPTY_FILE";
    throw error;
  }

  if (buffer.length > maxBytes) {
    const error = new Error(`That image is ${humanSize(buffer.length)}. The limit is ${humanSize(maxBytes)}.`);
    error.code = "FILE_TOO_LARGE";
    throw error;
  }

  const type = detectImageType(buffer);
  if (!type) {
    const error = new Error(
      "Only JPEG, PNG, WebP and AVIF images are allowed. " +
        (meta.declaredName ? `"${String(meta.declaredName).slice(0, 60)}" is not a supported image.` : "")
    );
    error.code = "UNSUPPORTED_IMAGE_TYPE";
    throw error;
  }

  await fsp.mkdir(UPLOAD_DIR, { recursive: true });

  // The name is generated, never derived from the upload. 24 hex characters of
  // entropy makes guessing another admin's file name pointless.
  const fileName = `${Date.now().toString(36)}-${crypto.randomBytes(12).toString("hex")}.${type.extension}`;
  await fsp.writeFile(path.join(UPLOAD_DIR, fileName), buffer, { flag: "wx" });

  return {
    fileName,
    path: `${UPLOAD_PUBLIC_PREFIX}${fileName}`,
    bytes: buffer.length,
    type: type.name
  };
}

/** True when a stored public path points into our upload directory. */
function isManagedUpload(publicPath) {
  return typeof publicPath === "string" && publicPath.startsWith(UPLOAD_PUBLIC_PREFIX);
}

/**
 * Delete an uploaded file, refusing anything outside the upload directory.
 * @returns {Promise<boolean>} true when a file was removed
 */
async function deleteManagedUpload(publicPath) {
  if (!isManagedUpload(publicPath)) return false;

  const fileName = publicPath.slice(UPLOAD_PUBLIC_PREFIX.length);
  if (!/^[A-Za-z0-9-]+\.(?:jpg|png|webp|avif)$/.test(fileName)) return false;

  const target = path.join(UPLOAD_DIR, fileName);
  // Defence in depth: the pattern above already excludes separators.
  if (path.dirname(path.resolve(target)) !== path.resolve(UPLOAD_DIR)) return false;

  try {
    await fsp.unlink(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** List stored uploads, newest first. Used by the editor's image picker. */
async function listUploads(limit = 40) {
  try {
    const names = await fsp.readdir(UPLOAD_DIR);
    const rows = names
      .filter(name => /\.(?:jpg|png|webp|avif)$/i.test(name))
      .map(name => {
        const stats = fs.statSync(path.join(UPLOAD_DIR, name));
        return {
          fileName: name,
          path: `${UPLOAD_PUBLIC_PREFIX}${name}`,
          bytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      .slice(0, limit);

    return rows;
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

module.exports = {
  SIGNATURES,
  UPLOAD_DIR,
  UPLOAD_PUBLIC_PREFIX,
  deleteManagedUpload,
  detectImageType,
  humanSize,
  isManagedUpload,
  listUploads,
  storeBannerImage
};