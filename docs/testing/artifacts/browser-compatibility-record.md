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
| Firefox (Playwright build 1538) | Waived (owner, 2026-08-15) | Headless Firefox cannot launch on this machine (macOS plugin-container sandbox failure: `Operation not permitted`) and the headful launch also fails here. The owner waived this row on 2026-08-15 and standardized browser testing on real Chrome. |
| VoiceOver (named screen reader) | Waived (owner, 2026-08-15) | The guidepup harness is ready but VoiceOver could not be started from this session. The owner waived the named-screen-reader row on 2026-08-15 ("no need to implement voiceover"); the harness remains available if a run is later required. |

The data-independent expectations (safety copy, rank criterion, focus return,
status announcements) passed identically in all three executed engines; no
engine-specific defect was observed. The Chrome run was refreshed on
2026-08-15T10:22Z against a freshly acquired generation (16/16). The two
manual rows were waived by the owner on 2026-08-15 in favor of the real-Chrome
standard. Note: an apparent Chrome-only "search
failed" state was traced to the server's correctly fail-closed stale
generation (503 `GENERATION_STALE`), not a browser difference — after a
fresh acquisition Chrome passed identically.
