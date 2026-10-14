import { secureHeaders } from "hono/secure-headers";

/**
 * Content Security Policy of the PWA: everything comes from this origin (scripts, styles, the
 * self-hosted fonts, icons, manifest, service worker, the API and its event stream). Directives
 * that would fall back to `default-src` are spelled out, so that relaxing it one day relaxes
 * nothing by accident. The end-to-end suite fails on any violation (apps/web/e2e/support.ts).
 */
export const CONTENT_SECURITY_POLICY = {
  defaultSrc: ["'self'"],
  // Vite emits external module scripts only: no inline script, no eval. Zod's compiler, which
  // uses `new Function`, is off in browsers (packages/shared/src/zod-config.ts).
  scriptSrc: ["'self'"],
  // vaul and Sonner insert <style> elements at runtime, and Radix's scroll lock
  // (react-remove-scroll) one whose content is computed then: no hash can match it, and a static,
  // precached index.html cannot carry a per-response nonce. CSS cannot run code; scripts stay
  // strict.
  styleSrc: ["'self'", "'unsafe-inline'"],
  // Style attributes in markup stay forbidden: React and the libraries set styles through the
  // CSSOM, which CSP leaves alone. (Browsers without CSP 3 apply style-src instead.)
  styleSrcAttr: ["'none'"],
  imgSrc: ["'self'"],
  fontSrc: ["'self'"],
  // fetch (push and pull) and EventSource (pokes).
  connectSrc: ["'self'"],
  workerSrc: ["'self'"],
  manifestSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'none'"],
  // Forms are handled in JavaScript: nothing is ever submitted natively.
  formAction: ["'none'"],
  // Never framed (clickjacking). X-Frame-Options says the same to older browsers.
  frameAncestors: ["'none'"],
};

/**
 * Powerful features Relevé does not use, denied to it and to anything it could embed: a feature
 * the app adopts (a screen wake lock during a survey, passkeys…) must be allowed here first. The
 * haptics' Vibration API is not governed by Permissions Policy. Only features every Chromium
 * recognises: an unknown one is logged as an error in the console (`web-share` is, on desktop).
 */
export const PERMISSIONS_POLICY = {
  accelerometer: [],
  autoplay: [],
  browsingTopics: [],
  camera: [],
  displayCapture: [],
  encryptedMedia: [],
  fullscreen: [],
  geolocation: [],
  gyroscope: [],
  hid: [],
  idleDetection: [],
  magnetometer: [],
  microphone: [],
  midi: [],
  payment: [],
  pictureInPicture: [],
  publickeyCredentialsGet: [],
  screenWakeLock: [],
  serial: [],
  usb: [],
  xrSpatialTracking: [],
};

/**
 * Security headers of every response: the policies above, plus Hono's defaults (HSTS, nosniff,
 * `Referrer-Policy: no-referrer`, same-origin COOP and CORP, Origin-Agent-Cluster…).
 */
export function securityHeaders() {
  return secureHeaders({
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
    permissionsPolicy: PERMISSIONS_POLICY,
    xFrameOptions: "DENY",
  });
}
