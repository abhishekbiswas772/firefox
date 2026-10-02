# Free VPN

A built-in, free, no-account VPN for Firefox on **Linux and Windows**. It sends
browser traffic through the [Tor network](https://www.torproject.org/) by
default, using a Tor process the browser starts and stops itself. It needs no
admin rights, no sign-up and no paid servers.

## Why Tor

The free, open source options compared:

| Option | Free | Open source | No account | Works without admin rights | Notes |
| --- | --- | --- | --- | --- | --- |
| **Tor** | Yes | Yes (BSD) | Yes | Yes (local SOCKS5 proxy) | Thousands of volunteer relays, exit country can be chosen, bridges get past censorship. Slower than a commercial VPN; some sites block it. |
| RiseupVPN / CalyxVPN | Yes | Yes (GPL) | Yes | No | OpenVPN-based system VPN. Needs a TUN device, so admin rights and a helper service. Few locations. |
| Psiphon | Yes | Yes (GPL) | Yes | Yes | Needs Psiphon-issued network config values to run the open source client. |
| Proton VPN free | Yes | Clients only | No | No | Requires an account; servers are not open source. |

Tor is the only option that is fully free, fully open source, needs no
account, and runs as an unprivileged local proxy on both Linux and Windows, so
it is the default. Any of the others can still be used through the
**Custom proxy** setting if they expose a local SOCKS5 or HTTP proxy.

## How it works

- `FreeVPNTorLauncher.sys.mjs` finds a `tor` binary, writes a `torrc` into
  `<profile>/freevpn/tor`, starts Tor with a random local SOCKS port and waits
  for it to bootstrap. Tor is told to exit when the browser exits
  (`__OwningControllerProcess`), even after a crash.
- `FreeVPNChannelFilter.sys.mjs` is an `nsIProtocolProxyChannelFilter` that
  sends every channel (or only private-window channels) to the tunnel. DNS is
  resolved by the proxy, so lookups do not leak. Localhost is never tunneled.
- **Kill switch** (on by default): while connecting, requests wait; if Tor
  fails or stops, requests are blocked instead of using the real connection.
- **New identity** changes the SOCKS credentials, which makes Tor
  (`IsolateSOCKSAuth`) build fresh circuits with a new exit IP.
- While connected, WebRTC is restricted to the proxy and DNS prefetching and
  speculative connections are turned off. These are set on the default pref
  branch, so they are undone on disconnect and never saved.
- `FreeVPNWidget.sys.mjs` adds a toolbar button whose panel has the on/off
  switch, status and exit IP, location (exit country), provider and options.

## Providers

| `browser.freevpn.provider` | What it uses |
| --- | --- |
| `tor` (default) | A Tor process started by the browser. |
| `tor-system` | A Tor already running on this computer (`browser.freevpn.system.port`, default 9050; use 9150 for a running Tor Browser). |
| `custom` | Any SOCKS5 / HTTP / HTTPS proxy (`browser.freevpn.custom.*`). |

Tor is looked up in this order: `browser.freevpn.tor.binaryPath`, the copy
bundled next to the browser (`freevpn-tor/tor/tor[.exe]`), common install
locations (`/usr/bin/tor`; `%ProgramFiles%\Tor`, Tor Browser on the Desktop),
then `PATH`. On Linux, `sudo apt install tor` (or your distribution's
equivalent) is enough.

For networks that block Tor, put bridge lines (from
<https://bridges.torproject.org/>) in `browser.freevpn.tor.bridges`, one per
line. obfs4 and webtunnel bridges use the `lyrebird` transport shipped with the
Tor Expert Bundle.

## Building (Linux and Windows only)

The feature is compiled in only when `OS_ARCH` is `Linux` or `WINNT`, and
`browser.freevpn.enabled` defaults to `true` only there.

Linux:

```sh
export MOZCONFIG=$PWD/browser/components/freevpn/build/mozconfig.linux64
./mach build
python3 browser/components/freevpn/tools/fetch_tor.py \
    --platform linux-x86_64 --dest obj-freevpn-linux64/dist/bin
./mach run
```

Windows (from a MozillaBuild shell):

```sh
export MOZCONFIG=$PWD/browser/components/freevpn/build/mozconfig.win64
./mach build
python3 browser/components/freevpn/tools/fetch_tor.py \
    --platform windows-x86_64 --dest obj-freevpn-win64/dist/bin
./mach run
```

The mozconfigs use artifact builds (prebuilt C++/Rust from Mozilla CI), which
is enough because Free VPN is front-end code. `fetch_tor.py` downloads the Tor
Expert Bundle from dist.torproject.org and checks its SHA-256 against the
published checksum list.

`.github/workflows/freevpn-build.yml` builds, lints, tests and packages both
platforms with Tor bundled, and uploads the archives as workflow artifacts.

## Tests

```sh
./mach xpcshell-test browser/components/freevpn/tests/xpcshell
```

## Limitations and next steps

- Only browser traffic is tunneled; other applications are not affected.
- UDP (WebRTC media, HTTP/3) cannot go through Tor; WebRTC is limited to the
  proxy while connected.
- Some websites block or add CAPTCHAs for Tor exit IPs.
- The custom proxy password is stored as a plain pref.
- Possible next steps: Snowflake bridges, a settings page in about:preferences,
  per-site exceptions, and an optional system-wide mode using RiseupVPN.
