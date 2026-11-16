/**
 * What the browser says about itself. Chromium's headless shell announces
 * `HeadlessChrome` in the UA and in `sec-ch-ua`, and Playwright turns on
 * `navigator.webdriver`; each one alone is enough for a site to refuse the page
 * without ever showing a challenge. This file removes the three obvious tells
 * and nothing else - it is not fingerprint spoofing.
 */

export type Brand = { brand: string; version: string };

export const VIEWPORT = { width: 1280, height: 800 };

export type Identity = {
  userAgent: string;
  acceptLanguage: string;
  metadata: {
    brands: Brand[];
    fullVersionList: Brand[];
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
};

/** `zh`/`zh-CN`/`en-US` all have one obvious accept-language. */
function languageOf(locale: string): string {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * `product` comes from CDP `Browser.getVersion`, e.g. `HeadlessChrome/141.0.7390.0`.
 * Only the major version is used, so the UA stays a plausible Chrome UA without
 * being pinned to a number that drifts away from the image.
 */
export function identityFor(product: string, locale: string): Identity {
  const version = product.split("/")[1] ?? "";
  const major = version.split(".")[0] ?? "";
  if (!/^\d+$/.test(major)) {
    throw new Error(`browser reported no usable version (${product})`);
  }
  const acceptLanguage = languageOf(locale);
  return {
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage,
    metadata: {
      brands: [
        { brand: "Not)A;Brand", version: "8" },
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
      ],
      fullVersionList: [
        { brand: "Not)A;Brand", version: "8.0.0.0" },
        { brand: "Chromium", version },
        { brand: "Google Chrome", version },
      ],
      platform: "Linux",
      platformVersion: "",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}

/** The launch flags that keep the shell honest about not being driven. */
export function launchOptions(): Record<string, unknown> {
  return {
    // Chromium sets navigator.webdriver only because Playwright passes this one.
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    acceptDownloads: false,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--disable-blink-features=AutomationControlled",
    ],
  };
}
