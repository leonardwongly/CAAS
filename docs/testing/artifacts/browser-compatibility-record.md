# Browser compatibility record — machine-executed passes (issue #17)

Recorded by a Playwright-driven keyboard-first execution of the §3 UAT script
against the served application (`http://localhost:18080`) with real CAAS data
(search subject `SIA469`). Per-engine row-level results and screenshots are
retained alongside this record.

| Engine | Result | Evidence |
|---|---|---|
| Chrome 151.0.7922 (real Chrome) | 16/16 rows pass | `uat-execution-record-chrome.md` + `uat-chrome-*.png` |
| Chromium (Playwright build 1228) | 16/16 rows pass | `uat-execution-record-chromium.md` + `uat-chromium-*.png` |
| WebKit 26.5 (Playwright build 2311, Safari engine) | 16/16 rows pass | `uat-execution-record-webkit.md` + `uat-webkit-*.png` |
| Firefox (Playwright build 1538) | Not executed | Headless Firefox cannot launch on this machine (macOS plugin-container sandbox failure: `Operation not permitted`); the headful launch also fails here, so a Firefox pass in the user's real browser remains a manual step. |
| VoiceOver (named screen reader) | Not executed | The guidepup harness is ready but cannot start VoiceOver until the host terminal app holds macOS Accessibility permission (System Settings → Privacy & Security → Accessibility). One-time grant, then the harness run completes this row. |

The data-independent expectations (safety copy, rank criterion, focus return,
status announcements) passed identically in all three executed engines; no
engine-specific defect was observed. Note: an apparent Chrome-only "search
failed" state was traced to the server's correctly fail-closed stale
generation (503 `GENERATION_STALE`), not a browser difference — after a
fresh acquisition Chrome passed identically.
