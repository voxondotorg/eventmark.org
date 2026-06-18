/**
 * Response hardening: CSP, framing, MIME sniffing, HSTS (HTTPS only).
 * Tune CSP here when adding new third-party scripts or API origins.
 */

export type SecurityProfile = "html" | "api" | "asset" | "embed";

/* picture-in-picture / xr-spatial-tracking are explicitly granted to the Turnstile widget origin;
 * Turnstile probes those features for fingerprinting and otherwise emits noisy console violations.
 * Added browsing-topics and interest-cohort to prevent console warnings (these are deprecated
 * but still requested by some browsers). */
const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(self), browsing-topics=(), camera=(self), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), interest-cohort=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(self "https://challenges.cloudflare.com"), publickey-credentials-get=(self), screen-wake-lock=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=(self "https://challenges.cloudflare.com")';

/* Cloudflare auto-injects the RUM (Browser Insights / Web Analytics) beacon on proxied
 * zones. To keep CSP strict we allowlist its loader origin and the (stable) inline-loader
 * SHA-256 hash. To remove these exceptions: turn off Browser Insights / Web Analytics
 * auto-injection for the zone in the Cloudflare dashboard. */
const CF_RUM_LOADER_HASH = "'sha256-qZF6/T0LTm0fUHe/lGduVtS5Gtbvp8GaVP5FJiYUBws=' 'sha256-YS5gL5OC8UH8tIKRfS/OP/PY8P8lSxtJL5WxJgUB268='";

/* Turnstile requires inline script execution within its iframe. The hashes below cover
 * the inline scripts that Turnstile injects. These are stable across Turnstile versions.
 * If Turnstile updates, these hashes may need updating based on browser console errors. */
const TURNSTILE_INLINE_HASHES = "'sha256-d5lv7AHXT3/OhUQUYZCSHZyBmdTj6TCmBUud4TDiroo=' 'sha256-eJGI0Ik4oYe/PKLDOt4wcN76wYs8h+Ew05pMzdY6xG8='";

/** Shell + Turnstile + Cloudflare RUM; inline styles only where unavoidable (none in index shell).
 * NOTE: 'unsafe-inline' is required for Turnstile to function properly as it injects inline scripts
 * into its iframe. The hashes above provide additional security for known Turnstile scripts. */
const CSP_HTML = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com ${CF_RUM_LOADER_HASH} ${TURNSTILE_INLINE_HASHES}`,
  "frame-src https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://challenges.cloudflare.com",
  "font-src 'self'",
  "connect-src 'self' https://cloudflareinsights.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "upgrade-insecure-requests",
].join("; ");

/** Embeddable event cards: allow iframe embedding + inline date script. */
const CSP_EMBED = [
  "default-src 'none'",
  "base-uri 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-ancestors *",
].join("; ");

/** JSON APIs are not documents; lock down embedding. */
const CSP_API = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export function securityProfileFor(request: Request): SecurityProfile {
  const pathname = new URL(request.url).pathname;
  if (/^\/api\/events\/[^/]+\/embed\.html$/.test(pathname)) return "embed";
  if (pathname.startsWith("/api/")) return "api";
  if (
    pathname === "/styles.css" ||
    pathname === "/app.js" ||
    pathname === "/license" ||
    pathname.startsWith("/assets/")
  ) {
    return "asset";
  }
  return "html";
}

export interface ApplySecurityHeadersOptions {
  isHttps: boolean;
}

export function applySecurityHeaders(
  response: Response,
  profile: SecurityProfile,
  opts: ApplySecurityHeadersOptions
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (profile !== "embed") {
    headers.set("X-Frame-Options", "DENY");
  }
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-site");

  if (profile === "html") {
    headers.set("Content-Security-Policy", CSP_HTML);
  } else if (profile === "embed") {
    headers.set("Content-Security-Policy", CSP_EMBED);
  } else if (profile === "api") {
    headers.set("Content-Security-Policy", CSP_API);
    if (!headers.has("Cache-Control")) {
      headers.set("Cache-Control", "no-store");
    }
  }
  /* assets: baseline headers only; avoid document CSP on CSS/JS/SVG subresources */

  if (opts.isHttps) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
