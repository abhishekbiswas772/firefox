# Implementation checklist

Status of every requested feature on branch `claude/busy-tesla-k4f33u`.
"Verified in CI" means it is covered by an automated test that passes on
both Linux and Windows in `.github/workflows/freevpn-build.yml`.

Status values: **Done** (implemented and verified in CI), **Partly verified**
(implemented; the note says what CI cannot check), **Needs decision** (not
done, waiting on you), **Not possible** (cannot be done as asked; see note).

## Builds (Linux and Windows only)

| Item | Status | How it is checked |
| --- | --- | --- |
| Features compiled only for Linux and Windows (`OS_ARCH` gate, `#if` in prefs/manifest/markup) | Done | Linux and Windows CI builds |
| Linux x86_64 build + `.tar.xz` package | Done | CI build and `mach package` |
| Windows x86_64 build + `.zip` and installer `.exe` | Done | CI build and `mach package` |
| Tor bundled in the packages (`freevpn-tor/`), SHA-256 checked against Tor's published list | Done | CI bundling step |
| wireproxy bundled (`freevpn-wireguard/`), SHA-256 checked against GitHub's digest | Done | CI bundling step |
| uBlock Origin bundled (`distribution/extensions/`), id and Mozilla signature files checked | Done | CI bundling step; Firefox verifies the signature on install |
| Mozilla-branded release builds | Not possible | Builds are artifact builds: front-end built from this branch, C++/Rust from Mozilla's Nightly for the same revision. A full source build does not fit free CI runners. |
| Public GitHub Release with download links | Needs decision | Blocked by tool permissions; needs your go-ahead. Builds are downloadable as workflow artifacts. |

## Free VPN

| Item | Status | How it is checked |
| --- | --- | --- |
| Free, open source, no account, no paid tier, many countries (Tor) | Done | Research in README |
| Browser-only (other apps not affected) | Done | Design: proxy channel filter |
| One-click on/off toolbar button; arrow opens settings | Done | `browser_freevpn_toggle.js` |
| Settings panel (status, exit IP, provider, location, bridges, options) | Done | `browser_freevpn_toggle.js` (`test_panel`) |
| Kill switch: block instead of leaking when the tunnel fails | Done | `browser_freevpn_toggle.js`, `test_FreeVPNChannelFilter.js` |
| Split tunneling (per site; call sites and Claude skip the VPN by default) | Done | `browser_freevpn_toggle.js`, `test_FreeVPNChannelFilter.js` |
| Private-windows-only mode | Done | `browser_freevpn_toggle.js` |
| Video/audio calls work (WebRTC direct on split-tunneled sites, proxy-only elsewhere) | Partly verified | WebRTC pref switching is tested; real calls were not tested in CI |
| Exit country selection | Done | `test_FreeVPNTorProcess.js` (torrc), `test_FreeVPNTorLauncher.js` |
| New identity (new circuits / exit IP) | Done | `test_FreeVPNChannelFilter.js` |
| Tor lifecycle: start, bootstrap, stop, exits with the browser | Done | `test_FreeVPNTorProcess.js` (Linux) |
| Stall detection and crash reporting with tor's own message | Done | `test_FreeVPNTorProcess.js` (Linux) |
| Censored / weak networks: automatic Snowflake → obfs4 → meek bridges, remembered | Done | `test_FreeVPNTorProcess.js` (Linux) |
| Reconnect after network loss, sleep, or tor crash | Partly verified | Implemented; not exercised in CI |
| Battery saver (dormant when idle, less padding); Tor stopped when VPN is off | Done | `test_FreeVPNTorProcess.js`, `test_FreeVPNTorLauncher.js` |
| DNS and prefetch leak protection while connected | Done | `browser_freevpn_toggle.js` (WebRTC pref), channel filter tests |
| Custom proxy / existing Tor providers | Done | `browser_freevpn_toggle.js` uses the custom provider |
| Connection through the real Tor network | Partly verified | Not testable in CI (no outside network in tests); use a release build to check |
| WireGuard provider (Proton VPN Free, Cloudflare WARP, own server) via wireproxy | Done | `test_FreeVPNWireGuard.js`, `test_FreeVPNWireGuardProcess.js` (Linux), `browser_freevpn_toggle.js` |
| WireGuard file import drops shell hooks, file readable only by the user | Done | `test_FreeVPNWireGuard.js`, `test_FreeVPNWireGuardProcess.js` |
| Connection through a real WireGuard server | Partly verified | Needs your own config file; not testable in CI |
| "Very fast" | Partly verified | Fast with the WireGuard provider (Proton Free or WARP); those are free tiers of paid services. Tor stays free with no account but is slower. See README. |

## Ad blocker

| Item | Status | How it is checked |
| --- | --- | --- |
| One-click toggle (uBlock Origin, GPLv3, no paid allow-lists) | Done | `browser_adblock_toggle.js` |
| Firefox sponsored tiles, sponsored suggestions and VPN promos off while blocking | Done | `browser_adblock_toggle.js` |
| Works in private windows | Partly verified | Granted on install; not exercised in CI (needs the real add-on) |
| Blocking quality on real sites | Partly verified | That is uBlock Origin's own behaviour; not tested here |

## Claude

| Item | Status | How it is checked |
| --- | --- | --- |
| One-click Claude button opening claude.ai in the sidebar | Done | `browser_claude_button.js` |
| Button shows open/closed however the sidebar was opened | Done | `browser_claude_button.js` |
| First click picks Claude; another chosen chatbot is kept | Done | `browser_claude_button.js` |
| Summarize page / explain selection (Firefox's own chatbot features) | Done | Firefox's genai test suite runs in CI and passes |
| claude.ai works while the VPN is on (split-tunneled) | Done | Default prefs checked in `browser_claude_button.js` |
| Logging in to claude.ai in the sidebar | Partly verified | Not testable in CI (no outside network) |

## Chrome extensions

| Item | Status | How it is checked |
| --- | --- | --- |
| Chrome-style WebExtensions from addons.mozilla.org | Done | Firefox's existing support |
| Installing directly from the Chrome Web Store (CRX to XPI, MV3 shim) | Done | `test_ChromeWebStore.js`, `browser_chrome_web_store.js` |
| Real store download and Chrome-only APIs | Partly verified | Downloads from Google are not testable in CI; Chrome-only APIs stay missing |

## Test suites run on every push (Linux and Windows)

- Lint: ESLint, stylelint, Fluent, ruff
- xpcshell: `test_ChromeWebStore.js`, `test_FreeVPNChannelFilter.js`,
  `test_FreeVPNTorLauncher.js`, `test_FreeVPNWireGuard.js`,
  `test_FreeVPNTorProcess.js` and `test_FreeVPNWireGuardProcess.js` (Linux)
- Browser: `browser_freevpn_toggle.js`, `browser_adblock_toggle.js`,
  `browser_claude_button.js`, `browser_chrome_web_store.js`, and all of
  `browser/components/genai/tests/browser`
