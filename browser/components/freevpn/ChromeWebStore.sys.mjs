/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "ChromeWebStore",
    maxLogLevelPref: "browser.freevpn.loglevel",
  })
);

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/freeVpn.ftl", "branding/brand.ftl"])
);

const ENABLED_PREF = "browser.chromeWebStore.enabled";
const SIGNATURES_PREF = "xpinstall.signatures.required";
export const NOTIFICATION_ID = "chrome-web-store-install";
const CRX_URL =
  "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=%VERSION%&x=id%3D%ID%%26installsource%3Dondemand%26uc";
// The store only serves extensions to versions of Chrome it supports.
const CHROME_VERSION = "140.0.0.0";
export const SHIM_PATH = "_firefox_compat/background-shim.js";
const PR_RDWR = 0x04;
const PR_CREATE_FILE = 0x08;
const PR_TRUNCATE = 0x20;

const CWS_ID_RE = /^[a-p]{32}$/;

// Chrome-only permissions that Firefox would warn about. Their APIs are
// missing in Firefox, so extensions relying on them will be limited.
export const UNSUPPORTED_PERMISSIONS = new Set([
  "certificateProvider",
  "debugger",
  "desktopCapture",
  "documentScan",
  "enterprise.deviceAttributes",
  "enterprise.hardwarePlatform",
  "enterprise.networkingAttributes",
  "enterprise.platformKeys",
  "fontSettings",
  "gcm",
  "loginState",
  "offscreen",
  "platformKeys",
  "printerProvider",
  "printing",
  "printingMetrics",
  "processes",
  "readingList",
  "sidePanel",
  "system.cpu",
  "system.display",
  "system.memory",
  "system.storage",
  "tabCapture",
  "tts",
  "ttsEngine",
  "wallpaper",
]);

// Loaded before an MV3 service worker that now runs as a background script.
// importScripts() calls were already resolved into background.scripts, and
// chrome.offscreen documents are emulated with frames in the background page.
export const BACKGROUND_SHIM = `"use strict";
if (typeof globalThis.importScripts != "function") {
  globalThis.importScripts = () => {};
}
try {
  if (typeof chrome == "object" && !chrome.offscreen && typeof document == "object") {
    const frames = new Map();
    chrome.offscreen = {
      Reason: new Proxy({}, { get: (target, name) => name }),
      async createDocument({ url }) {
        if (frames.size) {
          throw new Error("Only a single offscreen document may be created.");
        }
        const frame = document.createElement("iframe");
        frame.src = chrome.runtime.getURL(url);
        const loaded = new Promise(resolve =>
          frame.addEventListener("load", resolve, { once: true })
        );
        document.body.append(frame);
        frames.set(url, frame);
        await loaded;
      },
      async closeDocument() {
        for (const frame of frames.values()) {
          frame.remove();
        }
        frames.clear();
      },
      async hasDocument() {
        return frames.size > 0;
      },
    };
  }
} catch (e) {}
`;

/**
 * Returns the Chrome Web Store extension id in a store URL, or null.
 *
 * @param {string|nsIURI} url
 * @returns {string|null}
 */
export function extensionIdFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url?.spec ?? url));
  } catch (e) {
    return null;
  }
  const isStore =
    parsed.protocol == "https:" &&
    (parsed.host == "chromewebstore.google.com" ||
      (parsed.host == "chrome.google.com" &&
        parsed.pathname.startsWith("/webstore/")));
  if (!isStore) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const index = parts.indexOf("detail");
  if (index == -1) {
    return null;
  }
  return parts.slice(index + 1).find(part => CWS_ID_RE.test(part)) ?? null;
}

/**
 * Strips the CRX header (version 2 or 3) and returns the ZIP payload.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Uint8Array}
 */
export function crxToZip(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const isZipAt = offset =>
    bytes[offset] == 0x50 &&
    bytes[offset + 1] == 0x4b &&
    bytes[offset + 2] == 0x03 &&
    bytes[offset + 3] == 0x04;
  if (isZipAt(0)) {
    return bytes;
  }
  if (
    bytes.length < 16 ||
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) != "Cr24"
  ) {
    throw new Error("Not a Chrome extension package");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  let start;
  if (version == 3) {
    start = 12 + view.getUint32(8, true);
  } else if (version == 2) {
    start = 16 + view.getUint32(8, true) + view.getUint32(12, true);
  } else {
    throw new Error(`Unsupported CRX version ${version}`);
  }
  if (start >= bytes.length || !isZipAt(start)) {
    throw new Error("Corrupt Chrome extension package");
  }
  return bytes.subarray(start);
}

/**
 * Finds literal importScripts("a.js", "b.js") calls in a service worker and
 * returns the scripts as extension-root paths, in order.
 *
 * @param {string} source - Service worker source.
 * @param {string} workerPath - Path of the worker within the extension.
 * @returns {string[]}
 */
export function findImportedScripts(source, workerPath) {
  const base = `https://ext.invalid/${workerPath}`;
  const result = [];
  for (const call of source.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
    for (const literal of call[1].matchAll(/(["'`])([^"'`]+)\1/g)) {
      let resolved;
      try {
        resolved = new URL(literal[2], base);
      } catch (e) {
        continue;
      }
      if (resolved.host == "ext.invalid") {
        const path = decodeURIComponent(resolved.pathname.slice(1));
        if (!result.includes(path)) {
          result.push(path);
        }
      }
    }
  }
  return result;
}

/**
 * Adapts a Chrome manifest so Firefox can load the extension.
 *
 * @param {object} original - The extension's manifest.json.
 * @param {string} crxId - The Chrome Web Store id.
 * @param {function(string): (string|null)} [readFile] - Reads a file from the
 *   package, used to resolve importScripts() in service workers.
 * @returns {{manifest: object, removedPermissions: string[], usesShim: boolean}}
 */
export function convertChromeManifest(original, crxId, readFile = () => null) {
  const manifest = structuredClone(original);
  const removedPermissions = [];
  let usesShim = false;

  manifest.browser_specific_settings ??= {};
  manifest.browser_specific_settings.gecko ??= {};
  manifest.browser_specific_settings.gecko.id ??= `${crxId}@chromewebstore`;

  const background = manifest.background;
  if (background?.service_worker) {
    if (!background.scripts && !background.page) {
      const worker = background.service_worker;
      const isModule = background.type == "module";
      const imported = isModule
        ? []
        : findImportedScripts(readFile(worker) ?? "", worker);
      manifest.background = { scripts: [SHIM_PATH, ...imported, worker] };
      if (isModule) {
        manifest.background.type = "module";
      }
      usesShim = true;
    } else {
      delete background.service_worker;
    }
  }

  for (const key of [
    "update_url",
    "key",
    "minimum_chrome_version",
    "differential_fingerprint",
    "export",
    "import",
    "oauth2",
  ]) {
    delete manifest[key];
  }

  if (manifest.incognito == "split") {
    manifest.incognito = "spanning";
  }

  if (manifest.side_panel?.default_path && !manifest.sidebar_action) {
    manifest.sidebar_action = {
      default_panel: manifest.side_panel.default_path,
    };
  }
  delete manifest.side_panel;

  for (const key of ["permissions", "optional_permissions"]) {
    if (Array.isArray(manifest[key])) {
      manifest[key] = manifest[key].filter(permission => {
        if (UNSUPPORTED_PERMISSIONS.has(permission)) {
          removedPermissions.push(permission);
          return false;
        }
        return true;
      });
    }
  }

  return { manifest, removedPermissions, usesShim };
}

function stringStream(text) {
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  stream.setUTF8Data(text);
  return stream;
}

/**
 * Converts the ZIP payload of a Chrome extension into a Firefox XPI file.
 *
 * @param {Uint8Array} zipBytes
 * @param {string} crxId
 * @param {string} xpiPath - Where to write the XPI.
 * @returns {Promise<{manifest: object, removedPermissions: string[]}>}
 */
export async function convertToXpi(zipBytes, crxId, xpiPath) {
  const zipPath = xpiPath + ".crx.zip";
  await IOUtils.write(zipPath, zipBytes);
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader
  );
  const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  let writerOpen = false;
  try {
    reader.open(new lazy.FileUtils.File(zipPath));
    const readFile = name => {
      if (!reader.hasEntry(name)) {
        return null;
      }
      const stream = reader.getInputStream(name);
      return lazy.NetUtil.readInputStreamToString(stream, stream.available(), {
        charset: "UTF-8",
      });
    };
    const manifestText = readFile("manifest.json");
    if (!manifestText) {
      throw new Error("The package has no manifest.json");
    }
    const result = convertChromeManifest(
      JSON.parse(manifestText.replace(/^\uFEFF/, "")),
      crxId,
      readFile
    );

    await IOUtils.remove(xpiPath, { ignoreAbsent: true });
    writer.open(
      new lazy.FileUtils.File(xpiPath),
      PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE
    );
    writerOpen = true;
    const now = Date.now() * 1000;
    const entries = reader.findEntries(null);
    while (entries.hasMore()) {
      const name = entries.getNext();
      if (
        name == "manifest.json" ||
        name.startsWith("_metadata/") ||
        name.startsWith("META-INF/")
      ) {
        continue;
      }
      if (reader.getEntry(name).isDirectory) {
        writer.addEntryDirectory(name, now, false);
      } else {
        writer.addEntryStream(
          name,
          now,
          Ci.nsIZipWriter.COMPRESSION_DEFAULT,
          reader.getInputStream(name),
          false
        );
      }
    }
    if (result.usesShim) {
      writer.addEntryStream(
        SHIM_PATH,
        now,
        Ci.nsIZipWriter.COMPRESSION_DEFAULT,
        stringStream(BACKGROUND_SHIM),
        false
      );
    }
    writer.addEntryStream(
      "manifest.json",
      now,
      Ci.nsIZipWriter.COMPRESSION_DEFAULT,
      stringStream(JSON.stringify(result.manifest, null, 2)),
      false
    );
    return result;
  } finally {
    if (writerOpen) {
      writer.close();
    }
    reader.close();
    await IOUtils.remove(zipPath, { ignoreAbsent: true });
  }
}

/**
 * Offers to install Chrome Web Store extensions when one of their store
 * pages is open, by converting the CRX into a Firefox add-on. Such add-ons
 * are not signed by Mozilla, so the first install asks once whether to allow
 * unsigned add-ons.
 */
export const ChromeWebStore = {
  _inited: false,
  _progressListener: null,

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  init() {
    if (this._inited || !this.enabled) {
      return;
    }
    this._inited = true;
    this._progressListener = {
      onLocationChange: (browser, webProgress, request, location) => {
        if (webProgress.isTopLevel) {
          this.onLocationChange(browser, location);
        }
      },
    };
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.addWindow(win);
    }
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
  },

  uninit() {
    if (!this._inited) {
      return;
    }
    this._inited = false;
    Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      win.gBrowser?.removeTabsProgressListener(this._progressListener);
    }
  },

  observe(subject, topic) {
    if (topic == "browser-delayed-startup-finished") {
      this.addWindow(subject);
    }
  },

  addWindow(win) {
    if (!win.gBrowser || win.closed) {
      return;
    }
    win.gBrowser.addTabsProgressListener(this._progressListener);
    this.onLocationChange(
      win.gBrowser.selectedBrowser,
      win.gBrowser.selectedBrowser.currentURI
    );
  },

  _notificationBox(browser) {
    return browser.getTabBrowser?.()?.getNotificationBox(browser) ?? null;
  },

  onLocationChange(browser, location) {
    const box = this._notificationBox(browser);
    if (!box) {
      return;
    }
    const id = extensionIdFromUrl(location);
    const existing = box.getNotificationWithValue(NOTIFICATION_ID);
    if (existing && existing.getAttribute("crx-id") != id) {
      box.removeNotification(existing);
    }
    if (!id || box.getNotificationWithValue(NOTIFICATION_ID)) {
      return;
    }
    this.showOffer(browser, box, id);
  },

  async showOffer(browser, box, id) {
    const notification = await box.appendNotification(
      NOTIFICATION_ID,
      {
        label: { "l10n-id": "cws-notification" },
        priority: box.PRIORITY_INFO_HIGH,
      },
      [
        {
          "l10n-id": "cws-add-button",
          callback: () => {
            this.install(browser, id).catch(e => {
              lazy.logConsole.error("Install failed", e);
              this.showError(browser, e);
            });
            return false;
          },
        },
      ]
    );
    notification?.setAttribute("crx-id", id);
  },

  async showError(browser, error) {
    const box = this._notificationBox(browser);
    if (!box) {
      return;
    }
    const existing = box.getNotificationWithValue(NOTIFICATION_ID);
    if (existing) {
      box.removeNotification(existing);
    }
    await box.appendNotification(NOTIFICATION_ID, {
      label: {
        "l10n-id": "cws-error",
        "l10n-args": { detail: String(error?.message ?? error) },
      },
      priority: box.PRIORITY_WARNING_MEDIUM,
    });
  },

  /**
   * Asks once whether add-ons that Mozilla has not signed may be installed,
   * which Chrome Web Store extensions need.
   *
   * @param {Window} win
   * @returns {Promise<boolean>}
   */
  async allowUnsignedInstalls(win) {
    if (!Services.prefs.getBoolPref(SIGNATURES_PREF, true)) {
      return true;
    }
    const [title, message] = await lazy.l10n.formatValues([
      "cws-unsigned-title",
      "cws-unsigned-message",
    ]);
    if (!Services.prompt.confirm(win, title, message)) {
      return false;
    }
    Services.prefs.setBoolPref(SIGNATURES_PREF, false);
    return true;
  },

  /**
   * Downloads a CRX from the Chrome Web Store.
   *
   * @param {string} id
   * @returns {Promise<ArrayBuffer>}
   */
  async downloadCrx(id) {
    const url = CRX_URL.replace("%VERSION%", CHROME_VERSION).replace(
      "%ID%",
      id
    );
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status})`);
    }
    return response.arrayBuffer();
  },

  /**
   * Downloads, converts and installs a Chrome Web Store extension, showing
   * Firefox's usual permission prompt.
   *
   * @param {Element} browser - The tab showing the store page.
   * @param {string} id - Chrome Web Store extension id.
   */
  async install(browser, id) {
    if (!CWS_ID_RE.test(id)) {
      throw new Error("Invalid extension id");
    }
    if (!(await this.allowUnsignedInstalls(browser.documentGlobal))) {
      return;
    }
    const zip = crxToZip(await this.downloadCrx(id));
    const dir = PathUtils.join(PathUtils.tempDir, "chrome-web-store");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const xpiPath = PathUtils.join(dir, `${id}.xpi`);
    const { removedPermissions } = await convertToXpi(zip, id, xpiPath);
    if (removedPermissions.length) {
      lazy.logConsole.warn(
        `${id} uses Chrome-only APIs: ${removedPermissions.join(", ")}`
      );
    }

    const install = await lazy.AddonManager.getInstallForFile(
      new lazy.FileUtils.File(xpiPath),
      null,
      { source: "chrome-web-store" }
    );
    if (install.state == lazy.AddonManager.STATE_DOWNLOAD_FAILED) {
      throw new Error(`The extension could not be read (${install.error})`);
    }
    lazy.AddonManager.installAddonFromAOM(browser, browser.currentURI, install);
  },
};

/**
 * Entry points registered in BrowserComponents.manifest.
 */
export const ChromeWebStoreStartup = {
  init() {
    ChromeWebStore.init();
  },
  uninit() {
    ChromeWebStore.uninit();
  },
};
