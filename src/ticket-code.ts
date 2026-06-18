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
