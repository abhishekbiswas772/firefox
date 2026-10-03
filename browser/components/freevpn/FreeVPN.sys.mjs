/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FreeVPNChannelFilter:
    "moz-src:///browser/components/freevpn/FreeVPNChannelFilter.sys.mjs",
  parseDomainList:
    "moz-src:///browser/components/freevpn/FreeVPNChannelFilter.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  FreeVPNError:
    "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs",
  FreeVPNTorLauncher:
    "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs",
  FreeVPNWireGuard:
    "moz-src:///browser/components/freevpn/FreeVPNWireGuard.sys.mjs",
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
const BYPASS_PREF = PREF_BRANCH + "bypassDomains";
const BRIDGE_TYPE_PREF = PREF_BRANCH + "tor.bridgeType";
const LAST_BRIDGE_PREF = PREF_BRANCH + "tor.lastWorkingBridgeType";
// Order tried by the "auto" bridge setting when a direct connection to Tor
// stalls: Snowflake looks like a video call, obfs4 like random bytes and meek
// like ordinary HTTPS to a large cloud provider.
const AUTO_BRIDGE_ORDER = ["none", "snowflake", "obfs4", "meek"];
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 5 * 1000;

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
  "bridgeType",
  BRIDGE_TYPE_PREF,
  "auto"
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "batterySaver",
  PREF_BRANCH + "batterySaver",
  true
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
  // A WireGuard server (Proton VPN, Cloudflare WARP, your own server) through
  // the userspace wireproxy client.
  WIREGUARD: "wireguard",
  // Any SOCKS5 / HTTP proxy, e.g. a local Psiphon or self-hosted server.
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
  // True while the user wants the VPN on, even if it is reconnecting.
  #wanted = false;
  #autoRetries = 0;
  #retryTimer = null;
  // XPCOM cannot take this object (a DOM EventTarget) as an observer, so a
  // plain forwarding object is registered instead.
  #observer = {
    observe: (subject, topic, data) => this.observe(subject, topic, data),
  };

  progress = 0;
  /** The bridge type of the current Tor connection ("none" if direct). */
  bridgeInUse = "none";
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
    return (
      this.provider == FreeVPNProviders.TOR ||
      this.provider == FreeVPNProviders.TOR_SYSTEM
    );
  }

  /** @returns {Set<string>} Sites that skip the VPN (split tunneling). */
  get bypassDomains() {
    return lazy.parseDomainList(Services.prefs.getStringPref(BYPASS_PREF, ""));
  }

  /**
   * @param {string} domain - A registrable domain, e.g. "example.com".
   * @returns {boolean}
   */
  isBypassed(domain) {
    return this.bypassDomains.has(domain.toLowerCase());
  }

  /**
   * Adds or removes a site from the split tunneling list.
   *
   * @param {string} domain
   * @param {boolean} bypass
   */
  setBypassed(domain, bypass) {
    const domains = this.bypassDomains;
    if (bypass) {
      domains.add(domain.toLowerCase());
    } else {
      domains.delete(domain.toLowerCase());
    }
    Services.prefs.setStringPref(BYPASS_PREF, [...domains].join(","));
  }

  init() {
    if (this.#inited) {
      return;
    }
    this.#inited = true;
    Services.prefs.addObserver(PREF_BRANCH, this.#observer);
    Services.obs.addObserver(this.#observer, "network:link-status-changed");
    Services.obs.addObserver(this.#observer, "wake_notification");
    this.#updateEnabled();
  }

  uninit() {
    if (!this.#inited) {
      return;
    }
    this.#inited = false;
    Services.prefs.removeObserver(PREF_BRANCH, this.#observer);
    Services.obs.removeObserver(this.#observer, "network:link-status-changed");
    Services.obs.removeObserver(this.#observer, "wake_notification");
    const wasConnected = this.#state == FreeVPNStates.ON;
    this.disconnect();
    Services.prefs.setBoolPref(WAS_CONNECTED_PREF, wasConnected);
    lazy.FreeVPNWidget.uninit();
  }

  observe(subject, topic, data) {
    if (
      topic == "network:link-status-changed" ||
      topic == "wake_notification"
    ) {
      if (
        (topic == "wake_notification" || data == "up") &&
        this.#wanted &&
        this.#state == FreeVPNStates.ERROR
      ) {
        this.#autoRetries = 0;
        this.reconnect();
      }
      return;
    }
    if (topic != "nsPref:changed") {
      return;
    }
    switch (data) {
      case BYPASS_PREF:
        if (this.#filter) {
          this.#filter.bypassDomains = this.bypassDomains;
        }
        break;
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
      case BRIDGE_TYPE_PREF:
      case PREF_BRANCH + "batterySaver":
      case PREF_BRANCH + "custom.type":
      case PREF_BRANCH + "custom.host":
      case PREF_BRANCH + "custom.port":
      case PREF_BRANCH + "system.port":
      case PREF_BRANCH + "wireguard.endpoint":
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

    this.#wanted = true;
    lazy.clearTimeout(this.#retryTimer);
    this.error = null;
    this.exitInfo = null;
    this.progress = 0;
    this.bridgeInUse = "none";
    this.#setState(FreeVPNStates.CONNECTING);

    if (!this.#filter) {
      this.#filter = new lazy.FreeVPNChannelFilter();
    }
    this.#filter.mode = lazy.mode;
    this.#filter.bypassDomains = this.bypassDomains;
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
      this.#autoRetries = 0;
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
      case FreeVPNProviders.WIREGUARD: {
        // #launcher holds whichever helper process the provider runs.
        this.#launcher = new lazy.FreeVPNWireGuard({
          onExit: detail => {
            if (isCurrent() && this.#state == FreeVPNStates.ON) {
              this.#fail(new lazy.FreeVPNError("wireguard-exited", detail));
              this.#scheduleRetry();
            }
          },
        });
        const port = await this.#launcher.start();
        return { type: "socks", host: "127.0.0.1", port };
      }
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
      default:
        return this.#startTor(isCurrent);
    }
  }

  /**
   * Starts Tor, falling back to built-in bridges when the bridge setting is
   * "auto" and a direct connection stalls (e.g. on a censored network).
   *
   * @param {function(): boolean} isCurrent
   */
  async #startTor(isCurrent) {
    let attempts = [lazy.bridgeType];
    if (lazy.bridgeType == "auto") {
      const available = new Set([
        "none",
        ...(await lazy.FreeVPNTorLauncher.availableBridgeTypes()),
      ]);
      attempts = AUTO_BRIDGE_ORDER.filter(type => available.has(type));
      const last = Services.prefs.getStringPref(LAST_BRIDGE_PREF, "none");
      if (attempts.includes(last)) {
        attempts = [last, ...attempts.filter(type => type != last)];
      }
    }

    let lastError;
    for (const bridgeType of attempts) {
      if (!isCurrent()) {
        throw new lazy.FreeVPNError("cancelled");
      }
      try {
        const proxy = await this.#launchTor(isCurrent, bridgeType);
        this.bridgeInUse = bridgeType;
        if (lazy.bridgeType == "auto") {
          Services.prefs.setStringPref(LAST_BRIDGE_PREF, bridgeType);
        }
        return proxy;
      } catch (e) {
        lastError = e;
        if (e.code != "tor-timeout" && e.code != "bridges-unavailable") {
          throw e;
        }
        lazy.logConsole.warn(`Tor with bridges "${bridgeType}" failed`, e);
      }
    }
    throw lastError;
  }

  async #launchTor(isCurrent, bridgeType) {
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
          this.#scheduleRetry();
        }
      },
    });
    this.bridgeInUse = bridgeType;
    const port = await this.#launcher.start({
      exitCountry: lazy.exitCountry,
      bridgeType,
      customBridges: lazy.bridges,
      batterySaver: lazy.batterySaver,
    });
    return { type: "socks", host: "127.0.0.1", port };
  }

  #scheduleRetry() {
    if (!this.#wanted || this.#autoRetries >= MAX_AUTO_RETRIES) {
      return;
    }
    this.#autoRetries++;
    lazy.clearTimeout(this.#retryTimer);
    this.#retryTimer = lazy.setTimeout(() => {
      if (this.#wanted && this.#state == FreeVPNStates.ERROR) {
        this.reconnect();
      }
    }, RETRY_DELAY_MS * this.#autoRetries);
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
    this.#wanted = false;
    lazy.clearTimeout(this.#retryTimer);
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
    const launcher = this.#launcher;
    this.#launcher = null;
    await launcher?.stop();
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
    // AbortSignal.timeout() needs a window, which system modules lack.
    const controller = new AbortController();
    const timer = lazy.setTimeout(
      () => controller.abort(),
      EXIT_CHECK_TIMEOUT_MS
    );
    try {
      const response = await fetch(lazy.checkUrl, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      const json = await response.json();
      return { ip: String(json.IP ?? ""), isTor: !!json.IsTor };
    } catch (e) {
      throw new lazy.FreeVPNError("proxy-unreachable", e.message);
    } finally {
      lazy.clearTimeout(timer);
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
