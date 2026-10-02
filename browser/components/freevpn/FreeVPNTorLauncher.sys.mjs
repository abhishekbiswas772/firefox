/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "FreeVPNTorLauncher",
    maxLogLevelPref: "browser.freevpn.loglevel",
  })
);

const IS_WIN = AppConstants.platform == "win";
const TOR_EXE = IS_WIN ? "tor.exe" : "tor";
const LYREBIRD_EXE = IS_WIN ? "lyrebird.exe" : "lyrebird";
const BUNDLED_TOR_DIR = "freevpn-tor";
const PT_DIR = "pluggable_transports";
// Give up if bootstrap makes no progress for this long (the pref, in
// seconds), or overall.
const STALL_PREF = "browser.freevpn.tor.stallTimeoutSeconds";
const BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 3000;

const BOOTSTRAP_RE = /Bootstrapped (\d+)%(?: \(([\w-]+)\))?/;
const SOCKS_LISTENER_RE =
  /Opened Socks listener connection \(ready\) on 127\.0\.0\.1:(\d+)/;
const ERROR_RE = /\[(?:err|warn)\] (.*)$/;

/**
 * Builds the contents of the torrc file used by the managed Tor process.
 *
 * @param {object} options
 * @param {string} options.dataDir - Tor's DataDirectory.
 * @param {number} [options.ownerPid] - Tor exits when this process exits.
 * @param {string} [options.exitCountry] - ISO 3166 alpha-2 country code.
 * @param {string} [options.geoipFile]
 * @param {string} [options.geoip6File]
 * @param {string[]} [options.bridges] - Bridge lines, e.g. "obfs4 1.2.3.4:443 ...".
 * @param {string[]} [options.transportPlugins] - ClientTransportPlugin lines.
 * @param {boolean} [options.batterySaver] - Less padding, sleep when idle.
 * @returns {string}
 */
export function buildTorrc({
  dataDir,
  ownerPid,
  exitCountry,
  geoipFile,
  geoip6File,
  bridges = [],
  transportPlugins = [],
  batterySaver = false,
}) {
  const lines = [
    "SocksPort 127.0.0.1:auto IsolateSOCKSAuth",
    `DataDirectory ${quote(dataDir)}`,
    "ClientOnly 1",
    "AvoidDiskWrites 1",
    "Log notice stdout",
  ];
  if (ownerPid) {
    lines.push(`__OwningControllerProcess ${ownerPid}`);
  }
  if (geoipFile) {
    lines.push(`GeoIPFile ${quote(geoipFile)}`);
  }
  if (geoip6File) {
    lines.push(`GeoIPv6File ${quote(geoip6File)}`);
  }
  if (exitCountry && /^[a-z]{2}$/i.test(exitCountry)) {
    lines.push(`ExitNodes {${exitCountry.toLowerCase()}}`, "StrictNodes 1");
  }
  if (batterySaver) {
    lines.push(
      "ReducedConnectionPadding 1",
      "DormantClientTimeout 10 minutes",
      "DormantTimeoutDisabledByIdleStreams 1"
    );
  }
  const bridgeLines = bridges
    .map(b => oneLine(b).replace(/^Bridge\s+/i, ""))
    .filter(Boolean);
  if (bridgeLines.length) {
    lines.push("UseBridges 1");
    for (const plugin of transportPlugins) {
      lines.push(oneLine(plugin));
    }
    for (const bridge of bridgeLines) {
      lines.push(`Bridge ${bridge}`);
    }
  }
  return lines.join("\n") + "\n";
}

function oneLine(value) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Reads the pt_config.json that ships with the Tor Expert Bundle.
 *
 * @param {object} config - Parsed pt_config.json.
 * @param {string} ptPath - Prefix substituted for ${pt_path}.
 * @returns {{transportPlugins: string[], bridges: {[type: string]: string[]}}}
 */
export function parsePtConfig(config, ptPath) {
  const transportPlugins = Object.values(config?.pluggableTransports ?? {})
    .filter(line => typeof line == "string")
    .map(line => line.replaceAll("${pt_path}", ptPath));
  const bridges = {};
  for (const [type, list] of Object.entries(config?.bridges ?? {})) {
    if (Array.isArray(list)) {
      bridges[type] = list.filter(line => typeof line == "string");
    }
  }
  return { transportPlugins, bridges };
}

function quote(path) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Parses a line of Tor's notice log.
 *
 * @param {string} line
 * @returns {{bootstrap?: number, tag?: string, socksPort?: number, problem?: string}}
 */
export function parseTorLogLine(line) {
  const result = {};
  let match = BOOTSTRAP_RE.exec(line);
  if (match) {
    result.bootstrap = parseInt(match[1], 10);
    result.tag = match[2];
  }
  match = SOCKS_LISTENER_RE.exec(line);
  if (match) {
    result.socksPort = parseInt(match[1], 10);
  }
  match = ERROR_RE.exec(line);
  if (match) {
    result.problem = match[1].trim();
  }
  return result;
}

/**
 * Starts and stops a Tor process owned by the browser.
 */
export class FreeVPNTorLauncher {
  #proc = null;
  #socksPort = 0;
  #lastProblem = "";
  #onProgress;
  #stopping = false;

  /**
   * @param {object} [callbacks]
   * @param {function(number, string): void} [callbacks.onProgress]
   *   Called with the bootstrap percentage and Tor's bootstrap tag.
   * @param {function(string): void} [callbacks.onExit]
   *   Called if Tor exits while it was expected to keep running.
   */
  constructor({ onProgress = () => {}, onExit = () => {} } = {}) {
    this.#onProgress = onProgress;
    this.onExit = onExit;
  }

  get running() {
    return !!this.#proc;
  }

  get socksPort() {
    return this.#socksPort;
  }

  /**
   * Returns the tor binary to run, or null if none could be found.
   *
   * Search order: the browser.freevpn.tor.binaryPath pref, the copy bundled
   * next to the browser binary, well-known install locations, and PATH.
   *
   * @returns {Promise<string|null>}
   */
  static async findTorBinary() {
    const candidates = [];
    const pref = Services.prefs.getStringPref(
      "browser.freevpn.tor.binaryPath",
      ""
    );
    if (pref) {
      candidates.push(pref);
    }
    candidates.push(FreeVPNTorLauncher.bundledPath(TOR_EXE));

    if (IS_WIN) {
      const env = Services.env;
      for (const base of [
        env.get("ProgramFiles"),
        env.get("ProgramFiles(x86)"),
        env.get("LOCALAPPDATA"),
      ]) {
        if (base) {
          candidates.push(PathUtils.join(base, "Tor", TOR_EXE));
        }
      }
      const home = env.get("USERPROFILE");
      if (home) {
        candidates.push(
          PathUtils.join(
            home,
            "Desktop",
            "Tor Browser",
            "Browser",
            "TorBrowser",
            "Tor",
            TOR_EXE
          )
        );
      }
    } else {
      candidates.push("/usr/bin/tor", "/usr/local/bin/tor", "/usr/sbin/tor");
    }

    for (const candidate of candidates) {
      try {
        if (await IOUtils.exists(candidate)) {
          return candidate;
        }
      } catch (e) {
        // Invalid paths (e.g. a relative pref value) are skipped.
      }
    }

    try {
      return await lazy.Subprocess.pathSearch(TOR_EXE);
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {...string} parts - Path components inside the bundled tor/ directory.
   * @returns {string}
   */
  static bundledPath(...parts) {
    const base = Services.dirsvc.get("GreBinD", Ci.nsIFile).path;
    return PathUtils.join(base, BUNDLED_TOR_DIR, "tor", ...parts);
  }

  /**
   * Looks for the GeoIP databases and pluggable transports that ship with
   * the Tor Expert Bundle, relative to the tor binary.
   *
   * @param {string} torPath
   */
  static async findSupportFiles(torPath) {
    const torDir = PathUtils.parent(torPath);
    const bundleDir = PathUtils.parent(torDir);
    const pick = async paths => {
      for (const p of paths) {
        if (await IOUtils.exists(p)) {
          return p;
        }
      }
      return undefined;
    };

    let pt = { transportPlugins: [], bridges: {} };
    const ptConfigPath = PathUtils.join(torDir, PT_DIR, "pt_config.json");
    if (await IOUtils.exists(ptConfigPath)) {
      try {
        // Relative to the working directory (the tor directory), because
        // ClientTransportPlugin cannot quote paths that contain spaces.
        const sep = IS_WIN ? "\\" : "/";
        pt = parsePtConfig(await IOUtils.readJSON(ptConfigPath), PT_DIR + sep);
      } catch (e) {
        lazy.logConsole.warn("Could not read pt_config.json", e);
      }
    }
    if (!pt.transportPlugins.length) {
      const lyrebird = await pick([
        PathUtils.join(torDir, LYREBIRD_EXE),
        "/usr/bin/lyrebird",
        "/usr/bin/obfs4proxy",
      ]);
      if (lyrebird && !/\s/.test(lyrebird)) {
        pt.transportPlugins.push(
          `ClientTransportPlugin meek_lite,obfs2,obfs3,obfs4,scramblesuit,webtunnel exec ${lyrebird}`
        );
      }
    }

    return {
      geoipFile: await pick([
        PathUtils.join(bundleDir, "data", "geoip"),
        PathUtils.join(torDir, "geoip"),
      ]),
      geoip6File: await pick([
        PathUtils.join(bundleDir, "data", "geoip6"),
        PathUtils.join(torDir, "geoip6"),
      ]),
      ...pt,
    };
  }

  /**
   * Returns the built-in bridge types available with the installed Tor,
   * e.g. ["snowflake", "obfs4", "meek"].
   *
   * @returns {Promise<string[]>}
   */
  static async availableBridgeTypes() {
    const torPath = await FreeVPNTorLauncher.findTorBinary();
    if (!torPath) {
      return [];
    }
    const { bridges } = await FreeVPNTorLauncher.findSupportFiles(torPath);
    return Object.keys(bridges).filter(type => bridges[type].length);
  }

  /**
   * Launches Tor and resolves once it has fully bootstrapped.
   *
   * @param {object} options
   * @param {string} [options.exitCountry]
   * @param {string} [options.bridgeType] - "none", "custom", or a built-in
   *   bridge type from pt_config.json such as "snowflake" or "obfs4".
   * @param {string[]} [options.customBridges] - Used for "custom".
   * @param {boolean} [options.batterySaver]
   * @returns {Promise<number>} The SOCKS port Tor is listening on.
   */
  async start({
    exitCountry = "",
    bridgeType = "none",
    customBridges = [],
    batterySaver = false,
  } = {}) {
    if (this.#proc) {
      throw new Error("Tor is already running");
    }
    this.#stopping = false;
    this.#lastProblem = "";
    this.#socksPort = 0;

    const torPath = await FreeVPNTorLauncher.findTorBinary();
    if (!torPath) {
      throw new FreeVPNError("tor-not-found");
    }

    const dataDir = PathUtils.join(PathUtils.profileDir, "freevpn", "tor");
    await IOUtils.makeDirectory(dataDir, {
      createAncestors: true,
      permissions: 0o700,
    });
    if (!IS_WIN) {
      await IOUtils.setPermissions(dataDir, 0o700);
    }

    const support = await FreeVPNTorLauncher.findSupportFiles(torPath);
    let bridges = [];
    if (bridgeType == "custom") {
      bridges = customBridges;
    } else if (bridgeType != "none") {
      bridges = support.bridges[bridgeType] ?? [];
      if (!bridges.length) {
        throw new FreeVPNError("bridges-unavailable", bridgeType);
      }
    }

    const torrcPath = PathUtils.join(dataDir, "torrc");
    await IOUtils.writeUTF8(
      torrcPath,
      buildTorrc({
        dataDir,
        ownerPid: Services.appinfo.processID,
        exitCountry,
        geoipFile: support.geoipFile,
        geoip6File: support.geoip6File,
        bridges,
        transportPlugins: support.transportPlugins,
        batterySaver,
      })
    );

    const environment = {};
    if (!IS_WIN) {
      environment.LD_LIBRARY_PATH = PathUtils.parent(torPath);
    }

    lazy.logConsole.info(`Launching ${torPath} (bridges: ${bridgeType})`);
    this.#proc = await lazy.Subprocess.call({
      command: torPath,
      arguments: ["-f", torrcPath, "--ignore-missing-torrc"],
      environment,
      environmentAppend: true,
      stderr: "stdout",
      workdir: PathUtils.parent(torPath),
    });

    const proc = this.#proc;
    const ready = Promise.withResolvers();
    const overallTimer = lazy.setTimeout(
      () => ready.reject(new FreeVPNError("tor-timeout", this.#lastProblem)),
      BOOTSTRAP_TIMEOUT_MS
    );
    let stallTimer = null;
    const resetStallTimer = () => {
      lazy.clearTimeout(stallTimer);
      stallTimer = lazy.setTimeout(
        () => ready.reject(new FreeVPNError("tor-timeout", this.#lastProblem)),
        Services.prefs.getIntPref(STALL_PREF, 60) * 1000
      );
    };
    resetStallTimer();

    const outputDone = this.#readOutput(proc, ready, resetStallTimer);
    proc.wait().then(async ({ exitCode }) => {
      if (this.#proc === proc) {
        this.#proc = null;
      }
      // Tor's last words (usually the reason it exited) may still be buffered.
      await outputDone;
      const detail = this.#lastProblem || `exit code ${exitCode}`;
      ready.reject(new FreeVPNError("tor-exited", detail));
      if (!this.#stopping) {
        this.onExit(detail);
      }
    });

    try {
      await ready.promise;
    } catch (e) {
      await this.stop();
      throw e;
    } finally {
      lazy.clearTimeout(overallTimer);
      lazy.clearTimeout(stallTimer);
    }
    return this.#socksPort;
  }

  async #readOutput(proc, ready, onAdvance) {
    let buffer = "";
    let bootstrapped = false;
    let lastPercent = -1;
    try {
      let chunk;
      while ((chunk = await proc.stdout.readString())) {
        buffer += chunk;
        let lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          lazy.logConsole.debug(line);
          const parsed = parseTorLogLine(line);
          if (parsed.problem) {
            this.#lastProblem = parsed.problem;
          }
          if (parsed.socksPort) {
            this.#socksPort = parsed.socksPort;
          }
          if (parsed.bootstrap !== undefined) {
            if (parsed.bootstrap > lastPercent) {
              lastPercent = parsed.bootstrap;
              onAdvance();
            }
            this.#onProgress(parsed.bootstrap, parsed.tag ?? "");
            bootstrapped = parsed.bootstrap == 100;
          }
          if (bootstrapped && this.#socksPort) {
            ready.resolve();
          }
        }
      }
    } catch (e) {
      lazy.logConsole.debug("Tor output closed", e);
    }
  }

  /**
   * Terminates the Tor process if it is running.
   */
  async stop() {
    const proc = this.#proc;
    this.#proc = null;
    this.#socksPort = 0;
    if (!proc) {
      return;
    }
    this.#stopping = true;
    try {
      await proc.kill(SHUTDOWN_TIMEOUT_MS);
    } catch (e) {
      lazy.logConsole.warn("Failed to stop Tor", e);
    }
  }
}

/**
 * An error with a stable code that the UI maps to a localized message.
 */
export class FreeVPNError extends Error {
  /**
   * @param {string} code - One of "tor-not-found", "tor-timeout",
   *   "tor-exited", "bridges-unavailable", "proxy-unreachable",
   *   "custom-not-configured".
   * @param {string} [detail] - Untranslated technical detail.
   */
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}
