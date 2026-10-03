# Free VPN and ad blocker

Built-in privacy features for Firefox on **Linux and Windows**:

- **Free VPN**: browser traffic goes through the
  [Tor network](https://www.torproject.org/), using a Tor process the browser
  starts and stops itself. One click turns it on or off. No account, no paid
  servers, no admin rights. Only the browser is tunneled.
- **Ad blocker**: one click turns [uBlock Origin](https://github.com/gorhill/uBlock)
  on or off. While on, Firefox's own sponsored tiles and suggestions are also
  turned off.
- **Claude**: one click opens [claude.ai](https://claude.ai) in the sidebar,
  next to the page you are reading.

## Choosing the VPN

Requirements: free with no paid tier, many countries, fast, browser-only, and
no admin rights (so it must run as a local SOCKS/HTTP proxy, not a system VPN
adapter).

| Option | Cost model | Speed (typical) | Countries | Logs / who can see traffic | Browser-only without admin |
| --- | --- | --- | --- | --- | --- |
| **Tor** (built in) | Free, volunteer-run | ~5-20 Mbps; Conflux helps | Many, selectable | No single party sees both you and the site | Yes |
| VPN Gate (SoftEther, Univ. of Tsukuba) | Free, volunteer-run | Reviews measured ~1-2 Mbps average; some servers much faster | Many | Connection logs kept 3+ months; volunteer operators can see unencrypted traffic | No: SoftEther protocol and its OpenVPN mode (CBC ciphers only) have no userspace client |
| RiseupVPN / CalyxVPN | Free, donation-funded | Reported 40-120 Mbps | ~5 locations | No logs | Not yet: OpenVPN; the only userspace OpenVPN-to-SOCKS client found is brand new |
| Psiphon | Free tier of a paid app | Capped at ~2 Mbps | Many | Psiphon sees traffic metadata | Yes (local SOCKS), but needs Psiphon-issued config |
| Proton VPN Free | Free tier of a paid product, account needed | Good | 10 countries, picked automatically | No-logs policy | Yes via WireGuard config + wireproxy |
| Cloudflare WARP | Free tier of WARP+ | Fastest | Exits near you only | Cloudflare sees metadata | Yes via WireGuard + wireproxy; free registration uses an unofficial client |
| Own WireGuard server on Oracle Cloud Always Free | Free cloud tier (10 TB/month egress) | Fast (your own VM) | One region per account | Only you | Yes via WireGuard + wireproxy; sign-up is often hard |

Findings:

- No option is free with no paid tier, many countries, and as fast as a paid
  VPN at the same time; someone has to pay for the bandwidth.
- Among the options with no strings at all (no account, no paid tier), Tor is
  the only one that works inside the browser without admin rights. VPN Gate
  would need the SoftEther client and a system VPN adapter, and measured
  slower than Tor on average.
- The way to get real speed is WireGuard through
  [wireproxy](https://github.com/whyvl/wireproxy) (ISC licence, userspace,
  exposes SOCKS5): it works with Proton VPN Free, Cloudflare WARP, or your own
  free cloud server. Adding a WireGuard provider is the proposed next step.

Any service that already exposes a local SOCKS5 or HTTP proxy can be used now
with the **Custom proxy** setting.

## VPN features

- **One-click toggle**: the toolbar button turns the VPN on or off; the arrow
  next to it opens the settings panel.
- **Kill switch** (on by default): while connecting, requests wait; if the
  tunnel fails, requests are blocked instead of using the real connection.
- **Split tunneling**: sites in `browser.freevpn.bypassDomains`, and everything
  they load, use the normal connection. The panel can add the current site.
  Common video and audio call sites are in the default list.
- **Calls**: WebRTC is only forced through the proxy for pages that were loaded
  through it, so calls on split-tunneled sites work normally, and other sites
  cannot see your real IP through WebRTC. (Calls cannot run over Tor itself:
  Tor carries TCP only.)
- **Locations**: pick the exit country, or leave it automatic (fastest).
- **New identity**: new Tor circuits and exit IP for new connections.
- **Bad or censored networks**: the "Automatic" bridge setting tries a direct
  connection, then the built-in Snowflake, obfs4 and meek bridges that ship
  with the Tor Expert Bundle, and remembers what worked. A stalled bootstrap
  (no progress for 60 s) moves on to the next option.
- **Reconnects** when the network comes back, after waking from sleep, and if
  Tor exits unexpectedly.
- **Battery saver** (on by default): Tor goes dormant when idle and sends less
  padding. Tor is stopped entirely when the VPN is off.
- **Leak protection** while connected: DNS is resolved by the proxy, DNS
  prefetching and speculative connections are off. These prefs are set on the
  default branch, so they are never saved and are undone on disconnect.

### Providers

| `browser.freevpn.provider` | What it uses |
| --- | --- |
| `tor` (default) | A Tor process started by the browser. |
| `tor-system` | A Tor already running on this computer (`browser.freevpn.system.port`, default 9050; 9150 for Tor Browser). |
| `custom` | Any SOCKS5 / HTTP / HTTPS proxy (`browser.freevpn.custom.*`). |

Tor is looked up in this order: `browser.freevpn.tor.binaryPath`, the copy
bundled with the browser (`freevpn-tor/tor/tor[.exe]`), common install
locations (`/usr/bin/tor`; `%ProgramFiles%\Tor`, Tor Browser on the Desktop),
then `PATH`.

## Ad blocker

[Brave](https://github.com/brave/adblock-rust) blocks ads with adblock-rust,
which Firefox also vendors (`toolkit/components/content-classifier/etp_engine`)
but only for Mozilla's tracker lists and without cosmetic filtering; adding ad
lists there needs C++ changes. uBlock Origin uses the same filter lists
(EasyList, EasyPrivacy, uBlock filters), adds cosmetic filtering and
scriptlets, is GPLv3 and has no paid "acceptable ads" programme, so it is the
engine used here. LibreWolf ships it the same way.

- The Mozilla-signed uBlock Origin XPI is bundled in
  `distribution/extensions/` and installed on first run. Without the bundled
  copy it is installed from addons.mozilla.org the first time the toggle is
  turned on.
- It is allowed in private windows.
- While ad blocking is on, sponsored new tab tiles and stories, sponsored
  address bar suggestions and VPN promos are off (only prefs you have not
  changed yourself are touched; they are restored when you turn it off).

## Claude

Firefox's AI chatbot sidebar (`browser/components/genai`) already hosts
claude.ai with your normal claude.ai login, and can send the page or a
selection to it ("Summarize page", "Explain this", and the selection
shortcut). This build makes it one click away:

- `ClaudeButton.sys.mjs` adds a **Claude** toolbar button that opens and closes
  the chatbot sidebar; it is highlighted while Claude is open, however it was
  opened (button, Ctrl+Alt+X, or the sidebar launcher).
- The first click chooses Claude (`https://claude.ai/new`) as the chatbot
  (`browser.ml.chat.provider`) if none was chosen yet; a different choice
  made in the sidebar is kept.
- claude.ai, claude.com and anthropic.com are in the VPN's split tunneling
  list by default, because Claude rejects or challenges many Tor exits and
  login would otherwise fail while the VPN is on.

## Building (Linux and Windows only)

The features are compiled in only when `OS_ARCH` is `Linux` or `WINNT`.

```sh
# Linux (Windows: use build/mozconfig.win64 from a MozillaBuild shell,
# and --platform windows-x86_64)
export MOZCONFIG=$PWD/browser/components/freevpn/build/mozconfig.linux64
./mach build
python3 browser/components/freevpn/tools/fetch_tor.py \
    --platform linux-x86_64 --dest obj-freevpn-linux64/dist/bin
python3 browser/components/freevpn/tools/fetch_ublock.py \
    --dest obj-freevpn-linux64/dist/bin
./mach run          # or ./mach package
```

The mozconfigs use artifact builds (prebuilt C++/Rust from Mozilla's Nightly),
which is enough because these features are front-end code.
`fetch_tor.py` checks the Tor Expert Bundle against Tor's published SHA-256
list; `fetch_ublock.py` checks the add-on id and Mozilla signature files, and
Firefox verifies the signature on install.

`.github/workflows/freevpn-build.yml` lints, tests, bundles and packages both
platforms and uploads the Linux tarball and the Windows zip and installer as
workflow artifacts.

## Tests

```sh
./mach xpcshell-test browser/components/freevpn/tests/xpcshell
./mach mochitest browser/components/freevpn/tests/browser
```

## Limitations

- Only browser traffic is tunneled.
- Tor is slower than a paid VPN; some sites block or challenge Tor exits.
- The custom proxy password is stored as a plain pref.
- Builds are Nightly-based artifact builds, not Mozilla-branded release builds.
