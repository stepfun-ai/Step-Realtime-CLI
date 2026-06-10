// @step-cli/realtime-aec — browser-helper acoustic echo cancellation.
//
// Provides BrowserAudioDriver: an AudioDriver that routes mic capture and
// speaker playback through a headless Chrome's getUserMedia({echoCancellation})
// (libwebrtc APM), so full-duplex voice doesn't self-trigger on its own echo.
// Opt-in; requires a Chrome/Chromium binary (auto-detected, or STEP_CHROME_PATH).

export { BrowserAudioDriver, SAMPLE_RATE } from "./browser-audio-driver.js";
export { findChrome } from "./find-chrome.js";
