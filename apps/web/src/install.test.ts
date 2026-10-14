import { describe, expect, it } from "vitest";
import { type InstallEnvironment, installOffer } from "./install";

const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
// iPadOS asks for the desktop site: the same user agent as Safari on a Mac.
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

function environment(overrides: Partial<InstallEnvironment>): InstallEnvironment {
  return {
    standalone: false,
    installed: false,
    canPrompt: false,
    userAgent: ANDROID,
    maxTouchPoints: 5,
    ...overrides,
  };
}

describe("installOffer", () => {
  it("offers the browser's prompt once it is available", () => {
    expect(installOffer(environment({ canPrompt: true }))).toBe("prompt");
    expect(installOffer(environment({}))).toBeNull();
  });

  it("explains the Share menu on an iPhone or an iPad, which have no prompt", () => {
    expect(installOffer(environment({ userAgent: IPHONE }))).toBe("ios");
    expect(installOffer(environment({ userAgent: MAC, maxTouchPoints: 5 }))).toBe("ios");
    expect(installOffer(environment({ userAgent: MAC, maxTouchPoints: 0 }))).toBeNull();
  });

  it("offers nothing once installed, or when opened as the installed app", () => {
    expect(installOffer(environment({ canPrompt: true, installed: true }))).toBeNull();
    expect(installOffer(environment({ canPrompt: true, standalone: true }))).toBeNull();
    expect(installOffer(environment({ userAgent: IPHONE, standalone: true }))).toBeNull();
  });
});
