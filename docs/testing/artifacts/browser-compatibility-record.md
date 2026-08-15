# Browser compatibility record — machine-executed passes (issue #17)

Recorded by a Playwright-driven keyboard-first execution of the §3 UAT script
against the served application (`http://localhost:18080`) with real CAAS data
(search subject `SIA469`). Per-engine row-level results and screenshots are
retained alongside this record.

| Engine | Result | Evidence |
|---|---|---|
| Chromium (Playwright build 1228) | 16/16 rows pass | `uat-execution-record-chromium.md` + `uat-chromium-*.png` |
| WebKit 26.5 (Playwright build 2311, Safari engine) | 16/16 rows pass | `uat-execution-record-webkit.md` + `uat-webkit-*.png` |
| Firefox (Playwright build 1538) | Not executed | Headless Firefox could not launch on this machine (macOS plugin-container sandbox failure: `Operation not permitted`); a headful Firefox pass remains a manual step. |
| VoiceOver (named screen reader) | Not executed | `@guidepup/guidepup` cannot start VoiceOver without the host process holding macOS Accessibility permission; the named screen-reader verification remains a manual step (grant the permission, then re-run the guidepup harness, or perform a manual VoiceOver pass). |

The data-independent expectations (safety copy, rank criterion, focus return,
status announcements) passed identically in both executed engines; no
engine-specific defect was observed.
