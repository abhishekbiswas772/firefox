/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  FreeVPNError:
    "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "FreeVPNWireGuard",
    maxLogLevelPref: "browser.freevpn.loglevel",
  })
);

const IS_WIN = AppConstants.platform == "win";
const WIREPROXY_EXE = IS_WIN ? "wireproxy.exe" : "wireproxy";
const BUNDLED_DIR = "freevpn-wireguard";
const BINARY_PREF = "browser.freevpn.wireguard.binaryPath";
const START_TIMEOUT_MS = 15 * 1000;
const POLL_MS = 100;
const SHUTDOWN_TIMEOUT_MS = 3000;

// Keys wireproxy understands. Anything else in an imported file, notably
// wg-quick's PreUp/PostUp/PreDown/PostDown shell commands, is dropped.
const ALLOWED_KEYS = {
  interface: ["PrivateKey", "Address", "DNS", "MTU", "ListenPort"],
  peer: [
    "PublicKey",
    "PresharedKey",
    "Endpoint",
    "AllowedIPs",
    "PersistentKeepalive",
  ],
};
const KEY_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;

/**
 * Validates a WireGuard configuration (as exported by Proton VPN, wgcf for
 * Cloudflare WARP, or a self-hosted server) and returns a copy that only
 * keeps the settings wireproxy uses.
 *
 * @param {string} text - Contents of a .conf file.
 * @returns {{config: string, endpoint: string}}
 * @throws {FreeVPNError} "wireguard-invalid" with a reason.
 */
export function sanitizeWireGuardConfig(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, "").trim();
    if (!line) {
      continue;
    }
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      current = ALLOWED_KEYS[name] ? { name, entries: [] } : null;
      if (current) {
        sections.push(current);
      }
      continue;
    }
    const pair = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!pair || !current) {
      continue;
    }
    const key = ALLOWED_KEYS[current.name].find(
      k => k.toLowerCase() == pair[1].toLowerCase()
    );
    if (key) {
      current.entries.push([key, pair[2].trim()]);
    }
  }

  const fail = reason => {
    throw new lazy.FreeVPNError("wireguard-invalid", reason);
  };
  const get = (section, key) =>
    section.entries.find(([k]) => k == key)?.[1] ?? "";

  const interfaces = sections.filter(s => s.name == "interface");
  const peers = sections.filter(s => s.name == "peer");
  if (interfaces.length != 1) {
    fail("expected one [Interface] section");
  }
  if (!peers.length) {
    fail("no [Peer] section");
  }
  const iface = interfaces[0];
  if (!KEY_RE.test(get(iface, "PrivateKey"))) {
    fail("missing or invalid PrivateKey");
  }
  if (!get(iface, "Address")) {
    fail("missing Address");
  }
  for (const peer of peers) {
    if (!KEY_RE.test(get(peer, "PublicKey"))) {
      fail("missing or invalid PublicKey");
    }
    if (!/^\S+:\d{1,5}$/.test(get(peer, "Endpoint"))) {
      fail("missing or invalid Endpoint");
    }
  }

  const lines = [];
  for (const section of sections) {
    lines.push(section.name == "interface" ? "[Interface]" : "[Peer]");
    for (const [key, value] of section.entries) {
      lines.push(`${key} = ${value}`);
    }
    lines.push("");
  }
  return { config: lines.join("\n"), endpoint: get(peers[0], "Endpoint") };
}

/**
 * Builds the wireproxy configuration that serves a SOCKS5 proxy on
 * 127.0.0.1:port through the WireGuard tunnel.
 *
 * @param {string} wgConfigPath
 * @param {number} port
 * @returns {string}
 */
export function buildWireproxyConfig(wgConfigPath, port) {
  return `WGConfig = ${wgConfigPath}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

function freePort() {
  const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(
    Ci.nsIServerSocket
  );
  socket.init(-1, true, -1);
  const port = socket.port;
  socket.close();
  return port;
}

/**
 * Resolves true if something accepts TCP connections on 127.0.0.1:port.
 * Raw socket transports do not go through proxy filters.
 *
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function canConnect(port) {
  const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(
    Ci.nsISocketTransportService
  );
  const transport = sts.createTransport([], "127.0.0.1", port, null, null);
  return new Promise(resolve => {
    let done = false;
    const finish = result => {
      if (!done) {
        done = true;
        transport.close(Cr.NS_OK);
        resolve(result);
      }
    };
    transport.setEventSink(
      {
        onTransportStatus(t, status) {
          if (status == Ci.nsISocketTransport.STATUS_CONNECTED_TO) {
            finish(true);
          }
        },
      },
      Services.tm.mainThread
    );
    const input = transport
      .openInputStream(0, 0, 0)
      .QueryInterface(Ci.nsIAsyncInputStream);
    input.asyncWait(
      {
        onInputStreamReady(stream) {
          try {
            stream.available();
            finish(true);
          } catch (e) {
            finish(false);
          }
        },
      },
      0,
      0,
      Services.tm.mainThread
    );
  });
}

/**
 * Runs wireproxy, a userspace WireGuard client that exposes a SOCKS5 proxy,
 * so WireGuard servers (Proton VPN, Cloudflare WARP, your own server) can be
 * used without admin rights or a system VPN adapter.
 */
export class FreeVPNWireGuard {
  #proc = null;
  #stopping = false;
  #output = "";

  /**
   * @param {object} [callbacks]
   * @param {function(string): void} [callbacks.onExit]
   *   Called if wireproxy exits while it was expected to keep running.
   */
  constructor({ onExit = () => {} } = {}) {
    this.onExit = onExit;
  }

  get running() {
    return !!this.#proc;
  }

  static get configPath() {
    return PathUtils.join(PathUtils.profileDir, "freevpn", "wireguard.conf");
  }

  /**
   * @returns {Promise<boolean>} True if a configuration has been imported.
   */
  static async hasConfig() {
    return IOUtils.exists(FreeVPNWireGuard.configPath);
  }

  /**
   * Validates and stores a WireGuard configuration in the profile, readable
   * only by the user.
   *
   * @param {string} text
   * @returns {Promise<string>} The server endpoint.
   */
  static async importConfig(text) {
    const { config, endpoint } = sanitizeWireGuardConfig(text);
    const dir = PathUtils.parent(FreeVPNWireGuard.configPath);
    await IOUtils.makeDirectory(dir, {
      createAncestors: true,
      permissions: 0o700,
    });
    await IOUtils.writeUTF8(FreeVPNWireGuard.configPath, config, {
      tmpPath: FreeVPNWireGuard.configPath + ".tmp",
    });
    if (!IS_WIN) {
      await IOUtils.setPermissions(FreeVPNWireGuard.configPath, 0o600);
    }
    Services.prefs.setStringPref(
      "browser.freevpn.wireguard.endpoint",
      endpoint
    );
    return endpoint;
  }

  static async removeConfig() {
    await IOUtils.remove(FreeVPNWireGuard.configPath, { ignoreAbsent: true });
    Services.prefs.clearUserPref("browser.freevpn.wireguard.endpoint");
  }

  /**
   * @returns {Promise<string|null>} The wireproxy binary, or null.
   */
  static async findBinary() {
    const candidates = [];
    const pref = Services.prefs.getStringPref(BINARY_PREF, "");
    if (pref) {
      candidates.push(pref);
    }
    const base = Services.dirsvc.get("GreBinD", Ci.nsIFile).path;
    candidates.push(PathUtils.join(base, BUNDLED_DIR, WIREPROXY_EXE));
    if (!IS_WIN) {
      candidates.push("/usr/bin/wireproxy", "/usr/local/bin/wireproxy");
    }
    for (const candidate of candidates) {
      try {
        if (await IOUtils.exists(candidate)) {
          return candidate;
        }
      } catch (e) {
        // Invalid paths are skipped.
      }
    }
    try {
      return await lazy.Subprocess.pathSearch(WIREPROXY_EXE);
    } catch (e) {
      return null;
    }
  }

  /**
   * Starts wireproxy and resolves once its SOCKS5 port accepts connections.
   *
   * @returns {Promise<number>} The SOCKS port.
   */
  async start() {
    if (this.#proc) {
      throw new Error("wireproxy is already running");
    }
    this.#stopping = false;
    this.#output = "";

    if (!(await FreeVPNWireGuard.hasConfig())) {
      throw new lazy.FreeVPNError("wireguard-not-configured");
    }
    const binary = await FreeVPNWireGuard.findBinary();
    if (!binary) {
      throw new lazy.FreeVPNError("wireguard-not-found");
    }

    const port = freePort();
    const proxyConfigPath = PathUtils.join(
      PathUtils.parent(FreeVPNWireGuard.configPath),
      "wireproxy.conf"
    );
    await IOUtils.writeUTF8(
      proxyConfigPath,
      buildWireproxyConfig(FreeVPNWireGuard.configPath, port)
    );

    lazy.logConsole.info(`Launching ${binary} on port ${port}`);
    const proc = await lazy.Subprocess.call({
      command: binary,
      arguments: ["-c", proxyConfigPath],
      stderr: "stdout",
    });
    this.#proc = proc;
    this.#readOutput(proc);

    let exited = false;
    proc.wait().then(({ exitCode }) => {
      exited = true;
      if (this.#proc === proc) {
        this.#proc = null;
      }
      if (!this.#stopping) {
        this.onExit(this.#lastLine() || `exit code ${exitCode}`);
      }
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) {
        throw new lazy.FreeVPNError(
          "wireguard-exited",
          this.#lastLine() || "wireproxy exited"
        );
      }
      if (await canConnect(port)) {
        return port;
      }
      await new Promise(resolve => lazy.setTimeout(resolve, POLL_MS));
    }
    await this.stop();
    throw new lazy.FreeVPNError("wireguard-timeout", this.#lastLine());
  }

  #lastLine() {
    return this.#output.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
  }

  async #readOutput(proc) {
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        // Keep only the tail; it holds the reason for a failure.
        this.#output = (this.#output + chunk).slice(-4096);
        lazy.logConsole.debug(chunk);
      }
    } catch (e) {
      lazy.logConsole.debug("wireproxy output closed", e);
    }
  }

  async stop() {
    const proc = this.#proc;
    this.#proc = null;
    if (!proc) {
      return;
    }
    this.#stopping = true;
    try {
      await proc.kill(SHUTDOWN_TIMEOUT_MS);
    } catch (e) {
      lazy.logConsole.warn("Failed to stop wireproxy", e);
    }
  }
}
