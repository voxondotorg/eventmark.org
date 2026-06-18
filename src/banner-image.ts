/** Validate optimized event banner uploads (300×300 WebP or JPEG). */

export const BANNER_SIZE = 300;
export const MAX_BANNER_BYTES = 150_000;

export function jpegDimensions(data: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return {
        h: (data[i + 5] << 8) | data[i + 6],
        w: (data[i + 7] << 8) | data[i + 8],
      };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    const len = (data[i + 2] << 8) | data[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

export function webpDimensions(data: Uint8Array): { w: number; h: number } | null {
  if (data.length < 30) return null;
  if (
    data[0] !== 0x52 ||
    data[1] !== 0x49 ||
    data[2] !== 0x46 ||
    data[3] !== 0x46 ||
    data[8] !== 0x57 ||
    data[9] !== 0x45 ||
    data[10] !== 0x42 ||
    data[11] !== 0x50
  ) {
    return null;
  }
  let offset = 12;
  while (offset + 8 <= data.length) {
    const tag = String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
    const size =
      data[offset + 4] |
      (data[offset + 5] << 8) |
      (data[offset + 6] << 16) |
      (data[offset + 7] << 24);
    if (tag === "VP8X" && offset + 18 <= data.length) {
      const w = 1 + (data[offset + 12] | (data[offset + 13] << 8) | (data[offset + 14] << 16));
      const h = 1 + (data[offset + 15] | (data[offset + 16] << 8) | (data[offset + 17] << 16));
      return { w, h };
    }
    if (tag === "VP8 " && offset + 18 <= data.length) {
      const dataStart = offset + 8;
      if (
        data[dataStart + 3] === 0x9d &&
        data[dataStart + 4] === 0x01 &&
        data[dataStart + 5] === 0x2a
      ) {
        const w = (data[dataStart + 6] | (data[dataStart + 7] << 8)) & 0x3fff;
        const h = (data[dataStart + 8] | (data[dataStart + 9] << 8)) & 0x3fff;
        return { w, h };
      }
    }
    if (size <= 0) break;
    offset += 8 + ((size + 1) & ~1);
  }
  return null;
}

export function validateBannerImage(
  bytes: Uint8Array
): { ok: true; contentType: "image/jpeg" | "image/webp" } | { ok: false; error: string } {
  if (bytes.byteLength === 0) return { ok: false, error: "empty_body" };
  if (bytes.byteLength > MAX_BANNER_BYTES) return { ok: false, error: "banner_too_large" };

  let dims: { w: number; h: number } | null = null;
  let contentType: "image/jpeg" | "image/webp" | null = null;

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    dims = jpegDimensions(bytes);
    contentType = "image/jpeg";
  } else if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    dims = webpDimensions(bytes);
    contentType = "image/webp";
  } else {
    return { ok: false, error: "invalid_format" };
  }

  if (!dims || dims.w !== BANNER_SIZE || dims.h !== BANNER_SIZE) {
    return { ok: false, error: "invalid_dimensions" };
  }
  return { ok: true, contentType: contentType! };
}
