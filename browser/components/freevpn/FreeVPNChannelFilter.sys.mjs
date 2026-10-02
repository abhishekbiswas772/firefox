/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "ProxyService", () =>
  Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
    Ci.nsIProtocolProxyService
  )
);

const { TRANSPARENT_PROXY_RESOLVES_HOST } = Ci.nsIProxyInfo;
const FAILOVER_TIMEOUT_S = 10;
// A port nothing should listen on, used to make requests fail instead of
// leaking out of the tunnel while the kill switch is engaged.
const BLACKHOLE_PORT = 9;

export const FreeVPNMode = Object.freeze({
  ALL: "all",
  PRIVATE: "private",
});

/**
 * @typedef {object} FreeVPNProxy
 * @property {"socks"|"socks4"|"http"|"https"} type - Proxy protocol.
 * @property {string} host - Proxy host name or IP address.
 * @property {number} port - Proxy port.
 * @property {string} [username] - Proxy user name, if it needs one.
 * @property {string} [password] - Proxy password, if it needs one.
 */

/**
 * Builds an nsIProxyInfo for a proxy description. SOCKS proxies get a
 * username so that Tor (IsolateSOCKSAuth) uses a separate circuit per value,
 * which is how "new identity" is implemented.
 *
 * @param {FreeVPNProxy} proxy
 * @param {string} isolationKey
 * @returns {nsIProxyInfo}
 */
export function makeProxyInfo(proxy, isolationKey) {
  const type = proxy.type.toLowerCase();
  if (type == "socks" || type == "socks4") {
    return lazy.ProxyService.newProxyInfoWithAuth(
      type,
      proxy.host,
      proxy.port,
      proxy.username || `freevpn-${isolationKey}`,
      proxy.password || isolationKey,
      "",
      isolationKey,
      TRANSPARENT_PROXY_RESOLVES_HOST,
      FAILOVER_TIMEOUT_S,
      null
    );
  }
  let authHeader = "";
  if (proxy.username) {
    authHeader = "Basic " + btoa(`${proxy.username}:${proxy.password ?? ""}`);
  }
  return lazy.ProxyService.newProxyInfo(
    type,
    proxy.host,
    proxy.port,
    authHeader,
    isolationKey,
    TRANSPARENT_PROXY_RESOLVES_HOST,
    FAILOVER_TIMEOUT_S,
    null
  );
}

/**
 * Returns true for hosts that must never be sent through the tunnel.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isLocalHost(host) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host == "localhost" ||
    host.endsWith(".localhost") ||
    host == "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * Returns true if host is domain or one of its subdomains.
 *
 * @param {string} host
 * @param {Iterable<string>} domains
 * @returns {boolean}
 */
export function hostMatchesDomains(host, domains) {
  host = host.toLowerCase();
  for (const domain of domains) {
    if (host == domain || host.endsWith("." + domain)) {
      return true;
    }
  }
  return false;
}

/**
 * Parses the comma or whitespace separated split tunneling list.
 *
 * @param {string} value
 * @returns {Set<string>}
 */
export function parseDomainList(value) {
  return new Set(
    value
      .split(/[\s,]+/)
      .map(d =>
        d
          .trim()
          .toLowerCase()
          .replace(/^\*?\./, "")
      )
      .filter(d => /^[a-z0-9.-]+$/.test(d) && d.includes("."))
  );
}

/**
 * Routes browser channels through the active free VPN tunnel.
 *
 * While the tunnel is connecting, channels that should be tunneled are held
 * back. When the kill switch is engaged they are sent to a dead proxy so they
 * fail rather than use the real connection.
 */
export class FreeVPNChannelFilter {
  /** @type {nsIProxyInfo|null} */
  #proxyInfo = null;
  /** @type {FreeVPNProxy|null} */
  #proxy = null;
  #pending = [];
  #active = false;
  #blocking = false;
  #mode = FreeVPNMode.ALL;

  /**
   * Hosts that are tunneled in every mode, such as the exit IP check.
   *
   * @type {Set<string>}
   */
  alwaysTunneledHosts = new Set();

  /**
   * Split tunneling: sites (and everything they load) that use the normal
   * connection. Used for video calls, which cannot run over Tor.
   *
   * @type {Set<string>}
   */
  bypassDomains = new Set();

  QueryInterface = ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]);

  static makeIsolationKey() {
    return Services.uuid.generateUUID().toString().slice(1, -1);
  }

  get active() {
    return this.#active;
  }

  get mode() {
    return this.#mode;
  }

  set mode(mode) {
    this.#mode = Object.values(FreeVPNMode).includes(mode)
      ? mode
      : FreeVPNMode.ALL;
  }

  /**
   * Begins intercepting channels. Channels are queued until setProxy() or
   * block() is called.
   */
  start() {
    if (this.#active) {
      return;
    }
    lazy.ProxyService.registerChannelFilter(this, 0);
    this.#active = true;
  }

  /**
   * Stops intercepting channels and lets any queued channels go direct.
   */
  stop() {
    if (!this.#active) {
      return;
    }
    lazy.ProxyService.unregisterChannelFilter(this);
    this.#active = false;
    this.#proxyInfo = null;
    this.#proxy = null;
    this.#blocking = false;
    this.#flush(null);
  }

  /**
   * Sets the proxy channels are sent to and releases queued channels.
   *
   * @param {FreeVPNProxy} proxy
   */
  setProxy(proxy) {
    this.#proxy = proxy;
    this.#blocking = false;
    this.#proxyInfo = makeProxyInfo(
      proxy,
      FreeVPNChannelFilter.makeIsolationKey()
    );
    this.#flush(this.#proxyInfo);
  }

  /**
   * Switches to fresh circuits / connections for all following requests.
   */
  newIdentity() {
    if (this.#proxy) {
      this.setProxy(this.#proxy);
    }
  }

  /**
   * Holds back new channels until setProxy() or block() is called.
   */
  hold() {
    this.#proxyInfo = null;
    this.#blocking = false;
  }

  /**
   * Engages the kill switch: tunneled channels fail instead of going direct.
   */
  block() {
    this.#blocking = true;
    this.#proxyInfo = null;
    this.#flush(this.#blackholeInfo());
  }

  #blackholeInfo() {
    return makeProxyInfo(
      { type: "socks", host: "127.0.0.1", port: BLACKHOLE_PORT },
      "blocked"
    );
  }

  #flush(proxyInfo) {
    const pending = this.#pending;
    this.#pending = [];
    for (const { channel, callback } of pending) {
      callback.onProxyFilterResult(
        proxyInfo && this.shouldProxy(channel) ? proxyInfo : null
      );
    }
  }

  /**
   * nsIProtocolProxyChannelFilter
   *
   * @param {nsIChannel} channel
   * @param {nsIProxyInfo|null} defaultProxyInfo
   * @param {nsIProxyProtocolFilterResult} callback
   */
  applyFilter(channel, defaultProxyInfo, callback) {
    if (!this.shouldProxy(channel)) {
      callback.onProxyFilterResult(defaultProxyInfo);
      return;
    }
    if (this.#proxyInfo) {
      callback.onProxyFilterResult(this.#proxyInfo);
      return;
    }
    if (this.#blocking) {
      callback.onProxyFilterResult(this.#blackholeInfo());
      return;
    }
    this.#pending.push({ channel, callback });
  }

  /**
   * @param {nsIChannel} channel
   * @returns {boolean}
   */
  shouldProxy(channel) {
    let host = "";
    try {
      host = channel.URI.host;
    } catch (e) {
      return false;
    }
    if (!host || isLocalHost(host)) {
      return false;
    }
    if (
      channel instanceof Ci.nsIHttpChannelInternal &&
      channel.isTRRServiceChannel
    ) {
      return false;
    }
    if (this.bypassDomains.size && this.#isBypassed(channel, host)) {
      return false;
    }
    if (
      this.#mode == FreeVPNMode.PRIVATE &&
      !this.alwaysTunneledHosts.has(host)
    ) {
      return !!channel.loadInfo?.originAttributes.privateBrowsingId;
    }
    return true;
  }

  #isBypassed(channel, host) {
    if (hostMatchesDomains(host, this.bypassDomains)) {
      return true;
    }
    const loadInfo = channel.loadInfo;
    // For a top-level navigation the top document is still the page being
    // left, so only the destination host counts.
    if (
      !loadInfo ||
      loadInfo.externalContentPolicyType == Ci.nsIContentPolicy.TYPE_DOCUMENT
    ) {
      return false;
    }
    let topHost = "";
    try {
      topHost = loadInfo.browsingContext?.top?.currentURI?.host ?? "";
    } catch (e) {
      return false;
    }
    return !!topHost && hostMatchesDomains(topHost, this.bypassDomains);
  }
}
