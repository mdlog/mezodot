// Shared paths and endpoints for the demo-video pipeline.

export const OUT = new URL('./out/', import.meta.url).pathname;
/** Chromium 153 from Playwright's cache: the browser judges will most likely use. */
export const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
/** The web app (Vite) and the Mezodot agent, both on Mezo testnet. */
export const APP = 'http://127.0.0.1:3000/';
export const AGENT = 'http://127.0.0.1:8787';
