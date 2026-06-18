/**
 * Minimal Code-39 barcode → SVG renderer.
 * Code-39 supports: 0-9, A-Z, space, and -.$/+%. Encoded as 9 bars per character
 * where each bar is wide (1) or narrow (0). This is enough for ticket codes
 * like "EM-AB12-CD34"; the email links to /api/tickets/<code>/barcode.svg
 * which the user opens on their phone for door scanning.
 */

const PATTERNS: Record<string, string> = {
  "0": "000110100",
  "1": "100100001",
  "2": "001100001",
  "3": "101100000",
  "4": "000110001",
  "5": "100110000",
  "6": "001110000",
  "7": "000100101",
  "8": "100100100",
  "9": "001100100",
  A: "100001001",
  B: "001001001",
  C: "101001000",
  D: "000011001",
  E: "100011000",
  F: "001011000",
  G: "000001101",
  H: "100001100",
  I: "001001100",
  J: "000011100",
  K: "100000011",
  L: "001000011",
  M: "101000010",
  N: "000010011",
  O: "100010010",
  P: "001010010",
  Q: "000000111",
  R: "100000110",
  S: "001000110",
  T: "000010110",
  U: "110000001",
  V: "011000001",
  W: "111000000",
  X: "010010001",
  Y: "110010000",
  Z: "011010000",
  "-": "010000101",
  ".": "110000100",
  " ": "011000100",
  $: "010101000",
  "/": "010100010",
  "+": "010001010",
  "%": "000101010",
  "*": "010010100", // start / stop sentinel
};

const VALID_CHARS = /^[0-9A-Z\-\. \$\/\+\%]+$/;

export function isCode39Compatible(text: string): boolean {
  return VALID_CHARS.test(text);
}

export function renderCode39Svg(text: string, opts?: {
  height?: number;
  narrow?: number;
  wide?: number;
  quiet?: number;
  background?: string;
  foreground?: string;
}): string {
  const value = text.toUpperCase();
  if (!isCode39Compatible(value)) {
    throw new Error("Code-39 supports only A-Z, 0-9, space, and -.$/+%");
  }
  const height = opts?.height ?? 80;
  const narrow = opts?.narrow ?? 2;
  const wide = opts?.wide ?? narrow * 2.5;
  const quiet = opts?.quiet ?? narrow * 10;
  const fg = opts?.foreground ?? "#000";
  const bg = opts?.background ?? "#fff";

  const sequence = `*${value}*`;
  let x = quiet;
  const rects: string[] = [];
  for (let i = 0; i < sequence.length; i++) {
    const ch = sequence[i];
    const pattern = PATTERNS[ch];
    if (!pattern) throw new Error(`Unsupported character: ${ch}`);
    for (let j = 0; j < 9; j++) {
      const w = pattern[j] === "1" ? wide : narrow;
      // Bars 0,2,4,6,8 are bars (drawn). Bars 1,3,5,7 are spaces.
      if (j % 2 === 0) {
        rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="${fg}" />`);
      }
      x += w;
    }
    // Inter-character gap (narrow space).
    x += narrow;
  }
  const totalWidth = x + quiet;
  // Caption: human-readable text underneath the bars.
  const captionY = height + 18;
  const svgHeight = height + 28;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${svgHeight}" width="${totalWidth}" height="${svgHeight}" role="img" aria-label="Ticket barcode ${value}">`,
    `<rect x="0" y="0" width="${totalWidth}" height="${svgHeight}" fill="${bg}" />`,
    rects.join(""),
    `<text x="${totalWidth / 2}" y="${captionY}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="14" fill="${fg}">${value}</text>`,
    `</svg>`,
  ].join("");
}

/** Generate a ticket code: prefix EM- + 12 chars from an unambiguous alphabet. */
export function generateTicketCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars: string[] = [];
  for (let i = 0; i < 12; i++) {
    chars.push(alphabet[bytes[i] % alphabet.length]);
    if (i === 3 || i === 7) chars.push("-");
  }
  return `EM-${chars.join("")}`;
}
