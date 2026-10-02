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

| Option | Free, no paid tier | Open source | No account | Many countries | Works in the browser without admin rights |
| --- | --- | --- | --- | --- | --- |
| **Tor** | Yes | Yes (BSD) | Yes | Yes (exit country can be picked) | Yes (local SOCKS5 proxy) |
| VPN Gate (Univ. of Tsukuba) | Yes | Client yes (SoftEther) | Yes | Yes | No: OpenVPN/L2TP/SSTP need a system VPN adapter |
| RiseupVPN / CalyxVPN | Yes (donations) | Yes (GPL) | Yes | Few | No: OpenVPN needs a system VPN adapter |
| Psiphon | Yes | Yes (GPL) | Yes | Yes | Needs network config values issued by Psiphon |
| Lantern, Proton VPN free, Cloudflare WARP | Free tier of a paid product | Partly | Varies | Limited | Varies |

Tor is the only option that is fully free with no paid tier, fully open source,
needs no account, offers many countries, and runs as an unprivileged local
proxy on both Linux and Windows. Its trade-off is speed: Tor is slower than a
commercial VPN and some sites block or challenge Tor exits. Nothing that is
free, unlimited and multi-country is also as fast as a paid VPN, because
someone has to pay for the bandwidth. Any other service that exposes a local
SOCKS5 or HTTP proxy can be used with the **Custom proxy** setting.

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
- Claude (`https://claude.ai/new`) is the default chatbot
  (`browser.ml.chat.provider`); you can still pick another in the sidebar.
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
