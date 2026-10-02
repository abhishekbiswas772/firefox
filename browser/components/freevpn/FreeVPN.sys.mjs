/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FreeVPNChannelFilter:
    "moz-src:///browser/components/freevpn/FreeVPNChannelFilter.sys.mjs",
  FreeVPNError:
    "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs",
  FreeVPNTorLauncher:
    "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs",
  FreeVPNWidget: "moz-src:///browser/components/freevpn/FreeVPNWidget.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "FreeVPN",
    maxLogLevelPref: "browser.freevpn.loglevel",
  })
);

const PREF_BRANCH = "browser.freevpn.";
const ENABLED_PREF = PREF_BRANCH + "enabled";
const AUTO_CONNECT_PREF = PREF_BRANCH + "autoConnect";
const WAS_CONNECTED_PREF = PREF_BRANCH + "wasConnected";
const EXIT_CHECK_TIMEOUT_MS = 30 * 1000;

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "provider",
  PREF_BRANCH + "provider",
  "tor"
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "mode",
  PREF_BRANCH + "mode",
  "all"
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "exitCountry",
  PREF_BRANCH + "exitCountry",
  ""
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "killSwitch",
  PREF_BRANCH + "killSwitch",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "bridges",
  PREF_BRANCH + "tor.bridges",
  "",
  null,
  value => value.split(/\r?\n|;/)
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "checkUrl",
  PREF_BRANCH + "checkUrl",
  "https://check.torproject.org/api/ip"
);

export const FreeVPNStates = Object.freeze({
  DISABLED: "disabled",
  OFF: "off",
  CONNECTING: "connecting",
  ON: "on",
  ERROR: "error",
});

export const FreeVPNProviders = Object.freeze({
  // Tor started and owned by the browser.
  TOR: "tor",
  // A Tor client already running on this computer (system service or Tor Browser).
  TOR_SYSTEM: "tor-system",
  // Any SOCKS5 / HTTP proxy, e.g. a local Psiphon, wireproxy or self-hosted server.
  CUSTOM: "custom",
});

// Exit countries offered in the UI. Tor accepts any ISO 3166 code.
export const FREEVPN_COUNTRIES = Object.freeze([
  "us",
  "ca",
  "de",
  "nl",
  "fr",
  "gb",
  "ch",
  "se",
  "no",
  "fi",
  "at",
  "ro",
  "pl",
  "jp",
  "sg",
  "au",
]);

// Prefs set (on the default branch, so never persisted) while connected, to
// stop traffic from going around the tunnel.
const SESSION_PREFS = [
  ["media.peerconnection.ice.proxy_only_if_behind_proxy", true],
  ["network.dns.disablePrefetch", true],
  ["network.prefetch-next", false],
  ["network.http.speculative-parallel-limit", 0],
];

/**
 * The free VPN service. It owns the tunnel (a managed Tor process or an
 * existing proxy), the channel filter that routes traffic into it, and the
 * toolbar widget.
 *
 * Fires "FreeVPN:StateChanged" events on itself.
 */
class FreeVPNService extends EventTarget {
  #state = FreeVPNStates.DISABLED;
  #inited = false;
  #filter = null;
  #launcher = null;
  #connectId = 0;
  #savedSessionPrefs = null;

  progress = 0;
  /** @type {{code: string, detail: string}|null} */
  error = null;
  /** @type {{ip: string, isTor: boolean}|null} */
  exitInfo = null;

  get state() {
    return this.#state;
  }

  get isSupportedPlatform() {
    return AppConstants.platform == "linux" || AppConstants.platform == "win";
  }

  get isEnabled() {
    return (
      this.isSupportedPlatform &&
      Services.prefs.getBoolPref(ENABLED_PREF, false)
    );
  }

  get provider() {
    return Object.values(FreeVPNProviders).includes(lazy.provider)
      ? lazy.provider
      : FreeVPNProviders.TOR;
  }

  get usesTor() {
    return this.provider != FreeVPNProviders.CUSTOM;
  }

  init() {
    if (this.#inited) {
      return;
    }
    this.#inited = true;
    Services.prefs.addObserver(PREF_BRANCH, this);
    this.#updateEnabled();
  }

  uninit() {
    if (!this.#inited) {
      return;
    }
    this.#inited = false;
    Services.prefs.removeObserver(PREF_BRANCH, this);
    const wasConnected = this.#state == FreeVPNStates.ON;
    this.disconnect();
    Services.prefs.setBoolPref(WAS_CONNECTED_PREF, wasConnected);
    lazy.FreeVPNWidget.uninit();
  }

  observe(subject, topic, data) {
    if (topic != "nsPref:changed") {
      return;
    }
    switch (data) {
      case ENABLED_PREF:
        this.#updateEnabled();
        break;
      case PREF_BRANCH + "mode":
        if (this.#filter) {
          this.#filter.mode = lazy.mode;
        }
        break;
      case PREF_BRANCH + "provider":
      case PREF_BRANCH + "exitCountry":
      case PREF_BRANCH + "tor.bridges":
      case PREF_BRANCH + "custom.type":
      case PREF_BRANCH + "custom.host":
      case PREF_BRANCH + "custom.port":
      case PREF_BRANCH + "system.port":
        if (
          this.#state == FreeVPNStates.ON ||
          this.#state == FreeVPNStates.CONNECTING
        ) {
          this.reconnect();
        }
        break;
    }
  }

  #updateEnabled() {
    if (this.isEnabled) {
      if (this.#state == FreeVPNStates.DISABLED) {
        this.#setState(FreeVPNStates.OFF);
        lazy.FreeVPNWidget.init();
        const autoConnect =
          Services.prefs.getBoolPref(AUTO_CONNECT_PREF, false) &&
          Services.prefs.getBoolPref(WAS_CONNECTED_PREF, false);
        if (autoConnect) {
          this.connect();
        }
      }
      return;
    }
    this.disconnect();
    lazy.FreeVPNWidget.uninit();
    this.#setState(FreeVPNStates.DISABLED);
  }

  #setState(state) {
    if (this.#state == state && state != FreeVPNStates.CONNECTING) {
      return;
    }
    this.#state = state;
    lazy.logConsole.debug(`State: ${state}`);
    this.dispatchEvent(new CustomEvent("FreeVPN:StateChanged"));
  }

  /**
   * Turns the VPN on.
   */
  async connect() {
    if (
      !this.isEnabled ||
      this.#state == FreeVPNStates.ON ||
      this.#state == FreeVPNStates.CONNECTING
    ) {
      return;
    }
    const connectId = ++this.#connectId;
    const isCurrent = () => connectId == this.#connectId;

    this.error = null;
    this.exitInfo = null;
    this.progress = 0;
    this.#setState(FreeVPNStates.CONNECTING);

    if (!this.#filter) {
      this.#filter = new lazy.FreeVPNChannelFilter();
    }
    this.#filter.mode = lazy.mode;
    this.#filter.alwaysTunneledHosts.clear();
    try {
      this.#filter.alwaysTunneledHosts.add(new URL(lazy.checkUrl).host);
    } catch (e) {
      lazy.logConsole.warn("Invalid browser.freevpn.checkUrl", e);
    }
    this.#filter.hold();
    this.#filter.start();
    this.#applySessionPrefs();

    try {
      const proxy = await this.#openTunnel(isCurrent);
      if (!isCurrent()) {
        return;
      }
      this.#filter.setProxy(proxy);
      // A proxy we did not start ourselves may not be running; check it
      // before reporting the tunnel as up.
      const exitInfo =
        this.provider == FreeVPNProviders.TOR ? null : await this.#lookupExit();
      if (!isCurrent()) {
        return;
      }
      this.exitInfo = exitInfo;
      this.progress = 100;
      this.#setState(FreeVPNStates.ON);
      Services.prefs.setBoolPref(WAS_CONNECTED_PREF, true);
      if (!exitInfo) {
        this.refreshExitInfo();
      }
    } catch (e) {
      if (!isCurrent()) {
        return;
      }
      lazy.logConsole.error("Could not connect", e);
      this.#fail(e);
    }
  }

  /**
   * @param {function(): boolean} isCurrent
   * @returns {Promise<import("./FreeVPNChannelFilter.sys.mjs").FreeVPNProxy>}
   */
  async #openTunnel(isCurrent) {
    switch (this.provider) {
      case FreeVPNProviders.TOR_SYSTEM:
        return {
          type: "socks",
          host: "127.0.0.1",
          port: Services.prefs.getIntPref(PREF_BRANCH + "system.port", 9050),
        };
      case FreeVPNProviders.CUSTOM: {
        const host = Services.prefs
          .getStringPref(PREF_BRANCH + "custom.host", "")
          .trim();
        const port = Services.prefs.getIntPref(PREF_BRANCH + "custom.port", 0);
        if (!host || port <= 0 || port > 65535) {
          throw new lazy.FreeVPNError("custom-not-configured");
        }
        return {
          type: Services.prefs.getStringPref(
            PREF_BRANCH + "custom.type",
            "socks"
          ),
          host,
          port,
          username: Services.prefs.getStringPref(
            PREF_BRANCH + "custom.username",
            ""
          ),
          password: Services.prefs.getStringPref(
            PREF_BRANCH + "custom.password",
            ""
          ),
        };
      }
      case FreeVPNProviders.TOR:
      default: {
        this.#launcher = new lazy.FreeVPNTorLauncher({
          onProgress: (percent, tag) => {
            if (!isCurrent()) {
              return;
            }
            this.progress = percent;
            this.progressTag = tag;
            this.#setState(FreeVPNStates.CONNECTING);
          },
          onExit: detail => {
            if (isCurrent() && this.#state == FreeVPNStates.ON) {
              this.#fail(new lazy.FreeVPNError("tor-exited", detail));
            }
          },
        });
        const port = await this.#launcher.start({
          exitCountry: lazy.exitCountry,
          bridges: lazy.bridges,
        });
        return { type: "socks", host: "127.0.0.1", port };
      }
    }
  }

  #fail(e) {
    this.error = {
      code: e.code ?? "unknown",
      detail: e.detail ?? String(e.message ?? e),
    };
    this.#launcher?.stop();
    this.#launcher = null;
    if (lazy.killSwitch) {
      this.#filter?.block();
    } else {
      this.#filter?.stop();
      this.#restoreSessionPrefs();
    }
    this.#setState(FreeVPNStates.ERROR);
  }

  /**
   * Turns the VPN off and restores the direct connection.
   */
  disconnect() {
    this.#connectId++;
    this.#filter?.stop();
    this.#launcher?.stop();
    this.#launcher = null;
    this.#restoreSessionPrefs();
    this.error = null;
    this.exitInfo = null;
    this.progress = 0;
    if (this.#state != FreeVPNStates.DISABLED) {
      Services.prefs.setBoolPref(WAS_CONNECTED_PREF, false);
      this.#setState(FreeVPNStates.OFF);
    }
  }

  async reconnect() {
    this.#connectId++;
    await this.#launcher?.stop();
    this.#launcher = null;
    this.#state = FreeVPNStates.OFF;
    await this.connect();
  }

  toggle() {
    if (
      this.#state == FreeVPNStates.OFF ||
      this.#state == FreeVPNStates.ERROR
    ) {
      if (this.#state == FreeVPNStates.ERROR) {
        this.#state = FreeVPNStates.OFF;
      }
      this.connect();
    } else {
      this.disconnect();
    }
  }

  /**
   * Uses fresh Tor circuits (and so a new exit IP) for new connections.
   */
  newIdentity() {
    if (this.#state != FreeVPNStates.ON) {
      return;
    }
    this.#filter.newIdentity();
    Services.obs.notifyObservers(null, "net:prune-all-connections");
    this.refreshExitInfo();
  }

  /**
   * Looks up the public IP address that websites currently see.
   */
  async refreshExitInfo() {
    const connectId = this.#connectId;
    this.exitInfo = null;
    try {
      const exitInfo = await this.#lookupExit();
      if (connectId != this.#connectId || this.#state != FreeVPNStates.ON) {
        return;
      }
      this.exitInfo = exitInfo;
      this.dispatchEvent(new CustomEvent("FreeVPN:StateChanged"));
    } catch (e) {
      lazy.logConsole.warn("Exit IP lookup failed", e);
    }
  }

  /**
   * @returns {Promise<{ip: string, isTor: boolean}>}
   */
  async #lookupExit() {
    try {
      const response = await fetch(lazy.checkUrl, {
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(EXIT_CHECK_TIMEOUT_MS),
      });
      const json = await response.json();
      return { ip: String(json.IP ?? ""), isTor: !!json.IsTor };
    } catch (e) {
      throw new lazy.FreeVPNError("proxy-unreachable", e.message);
    }
  }

  #applySessionPrefs() {
    if (this.#savedSessionPrefs) {
      return;
    }
    const defaults = Services.prefs.getDefaultBranch("");
    this.#savedSessionPrefs = [];
    for (const [name, value] of SESSION_PREFS) {
      const type = defaults.getPrefType(name);
      let old;
      if (type == Ci.nsIPrefBranch.PREF_BOOL) {
        old = defaults.getBoolPref(name);
      } else if (type == Ci.nsIPrefBranch.PREF_INT) {
        old = defaults.getIntPref(name);
      }
      this.#savedSessionPrefs.push([name, old]);
      setDefaultPref(defaults, name, value);
    }
  }

  #restoreSessionPrefs() {
    if (!this.#savedSessionPrefs) {
      return;
    }
    const defaults = Services.prefs.getDefaultBranch("");
    for (const [name, old] of this.#savedSessionPrefs) {
      if (old !== undefined) {
        setDefaultPref(defaults, name, old);
      }
    }
    this.#savedSessionPrefs = null;
  }
}

function setDefaultPref(branch, name, value) {
  if (typeof value == "boolean") {
    branch.setBoolPref(name, value);
  } else {
    branch.setIntPref(name, value);
  }
}

export const FreeVPN = new FreeVPNService();

/**
 * Entry points registered in BrowserComponents.manifest.
 */
export const FreeVPNStartup = {
  init() {
    if (FreeVPN.isSupportedPlatform) {
      FreeVPN.init();
    }
  },
  uninit() {
    FreeVPN.uninit();
  },
};
