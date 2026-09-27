function disabled() {
    throw new Error('Browser management is unavailable; publication requires an explicit system Chromium');
}
export const Browser = new Proxy(Object.freeze({}), { get: disabled });
export const ChromeReleaseChannel = new Proxy(Object.freeze({}), { get: disabled });
export const detectBrowserPlatform = disabled;
export const resolveDefaultUserDataDir = disabled;
