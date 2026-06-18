// @ts-nocheck
import { qrcodegen } from "./qrcodegen.js";

export function renderQrSvg(
  text: string,
  opts?: { size?: number; margin?: number; foreground?: string; background?: string }
): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const modules = qr.size;
  const margin = opts?.margin ?? 4;
  const total = modules + margin * 2;
  const size = opts?.size ?? 256;
  const scale = size / total;
  const fg = opts?.foreground ?? "#000";
  const bg = opts?.background ?? "#fff";

  const rects: string[] = [];
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (qr.getModule(x, y)) {
        const px = (x + margin) * scale;
        const py = (y + margin) * scale;
        rects.push(`<rect x="${px}" y="${py}" width="${scale}" height="${scale}" />`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="EventMark ticket QR code">`,
    `<rect width="${size}" height="${size}" fill="${bg}" />`,
    `<g fill="${fg}">`,
    rects.join(""),
    `</g>`,
    `</svg>`,
  ].join("");
}

/** Canonical EventMark check-in URL embedded in ticket QR codes. */
export function ticketCheckinUrl(publicSiteUrl: string, token: string): string {
  const base = publicSiteUrl.replace(/\/+$/, "");
  return `${base}/#/checkin?token=${encodeURIComponent(token)}`;
}

/** Public QR image URL for emails and dashboard ticket display. */
export function ticketQrImageUrl(publicSiteUrl: string, ticketCode: string): string {
  const base = publicSiteUrl.replace(/\/+$/, "");
  return `${base}/api/tickets/${encodeURIComponent(ticketCode)}/qr.svg`;
}
