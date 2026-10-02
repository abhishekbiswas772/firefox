/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () =>
  console.createInstance({
    prefix: "AdBlocker",
    maxLogLevelPref: "browser.freevpn.loglevel",
  })
);

export const UBO_ID = "uBlock0@raymondhill.net";
const AMO_URL =
  "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi";
const WIDGET_ID = "adblock-button";
const PREF_BRANCH = "browser.adblock.";
const ENABLED_PREF = PREF_BRANCH + "enabled";
const FEATURE_PREF = PREF_BRANCH + "feature.enabled";
const ADDED_PREF = PREF_BRANCH + "widgetAdded";
const ICON_BASE = "chrome://browser/content/freevpn/";

// Firefox's own paid placements, switched off while ad blocking is on.
// Only prefs the user has not changed themselves are touched.
export const SPONSORED_PREFS = [
  "browser.newtabpage.activity-stream.showSponsored",
  "browser.newtabpage.activity-stream.showSponsoredTopSites",
  "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
  "browser.urlbar.suggest.quicksuggest.sponsored",
  "browser.vpn_promo.enabled",
];
const OWNED_SPONSORED_PREF = PREF_BRANCH + "ownsSponsoredPrefs";
const PRIVATE_GRANTED_PREF = PREF_BRANCH + "privateWindowsGranted";

export const AdBlockerStates = Object.freeze({
  ON: "on",
  OFF: "off",
  // Being installed or enabled.
  BUSY: "busy",
  ERROR: "error",
});

/**
 * Built-in ad blocking with one toolbar toggle. Blocking is done by uBlock
 * Origin (GPLv3, no paid allow-lists), which is bundled in
 * <install>/distribution/extensions and otherwise installed from
 * addons.mozilla.org the first time the toggle is turned on.
 */
class AdBlockerService extends EventTarget {
  #state = AdBlockerStates.OFF;
  #inited = false;
  #widgetCreated = false;

  get state() {
    return this.#state;
  }

  get wanted() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  }

  async init() {
    if (this.#inited || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    this.#inited = true;
    lazy.AddonManager.addAddonListener(this);
    this.#createWidget();
    await this.#sync();
  }

  uninit() {
    if (!this.#inited) {
      return;
    }
    this.#inited = false;
    lazy.AddonManager.removeAddonListener(this);
    if (this.#widgetCreated) {
      lazy.CustomizableUI.destroyWidget(WIDGET_ID);
      this.#widgetCreated = false;
    }
  }

  async #getAddon() {
    return lazy.AddonManager.getAddonByID(UBO_ID);
  }

  /**
   * Makes the add-on state match the pref on startup.
   */
  async #sync() {
    let addon = await this.#getAddon();
    if (addon && !Services.prefs.getBoolPref(PRIVATE_GRANTED_PREF, false)) {
      // The bundled copy is installed by the add-on manager on first run,
      // without access to private windows.
      await this.#allowInPrivateWindows(addon);
      addon = await this.#getAddon();
    }
    // Tests must not download add-ons; they install a stand-in themselves.
    const mayInstall =
      !Cu.isInAutomation ||
      Services.prefs.getBoolPref(PREF_BRANCH + "testing.autoInstall", false);
    if (this.wanted && !addon?.isActive && (addon || mayInstall)) {
      await this.#turnOn(addon);
      return;
    }
    if (!this.wanted && addon?.isActive) {
      await addon.disable();
    }
    this.#setSponsoredPrefs(this.wanted && !!addon?.isActive);
    this.#refreshState(addon);
  }

  async toggle() {
    if (this.#state == AdBlockerStates.BUSY) {
      return;
    }
    const addon = await this.#getAddon();
    if (addon?.isActive) {
      Services.prefs.setBoolPref(ENABLED_PREF, false);
      await addon.disable();
      this.#setSponsoredPrefs(false);
      this.#refreshState(await this.#getAddon());
      return;
    }
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    await this.#turnOn(addon);
  }

  async #turnOn(addon) {
    this.#setState(AdBlockerStates.BUSY);
    try {
      if (!addon) {
        addon = await this.#install();
      } else if (!addon.isActive) {
        await addon.enable();
      }
      this.#setSponsoredPrefs(true);
    } catch (e) {
      lazy.logConsole.error("Could not turn on ad blocking", e);
      this.#setState(AdBlockerStates.ERROR);
      return;
    }
    this.#refreshState(await this.#getAddon());
  }

  async #install() {
    const bundled = Services.dirsvc.get("XREAppDist", Ci.nsIFile);
    bundled.append("extensions");
    bundled.append(`${UBO_ID}.xpi`);
    const install = bundled.exists()
      ? await lazy.AddonManager.getInstallForFile(bundled, null, {
          source: "distribution",
        })
      : await lazy.AddonManager.getInstallForURL(AMO_URL, {
          telemetryInfo: { source: "amo" },
        });
    const addon = await install.install();
    if (addon.id != UBO_ID) {
      await addon.uninstall();
      throw new Error(`Unexpected add-on ${addon.id}`);
    }
    await this.#allowInPrivateWindows(addon);
    return addon;
  }

  async #allowInPrivateWindows(addon) {
    const policy = WebExtensionPolicy.getByID(addon.id);
    await lazy.ExtensionPermissions.add(
      addon.id,
      { permissions: ["internal:privateBrowsingAllowed"], origins: [] },
      policy?.extension
    );
    Services.prefs.setBoolPref(PRIVATE_GRANTED_PREF, true);
    if (addon.isActive) {
      await addon.reload();
    }
  }

  /**
   * @param {boolean} hide - True to turn sponsored content off.
   */
  #setSponsoredPrefs(hide) {
    if (hide) {
      const owned = Services.prefs
        .getStringPref(OWNED_SPONSORED_PREF, "")
        .split(",")
        .filter(Boolean);
      for (const pref of SPONSORED_PREFS) {
        if (!Services.prefs.prefHasUserValue(pref)) {
          Services.prefs.setBoolPref(pref, false);
          if (!owned.includes(pref)) {
            owned.push(pref);
          }
        }
      }
      if (owned.length) {
        Services.prefs.setStringPref(OWNED_SPONSORED_PREF, owned.join(","));
      }
      return;
    }
    const owned = Services.prefs
      .getStringPref(OWNED_SPONSORED_PREF, "")
      .split(",")
      .filter(pref => SPONSORED_PREFS.includes(pref));
    for (const pref of owned) {
      Services.prefs.clearUserPref(pref);
    }
    Services.prefs.clearUserPref(OWNED_SPONSORED_PREF);
  }

  #refreshState(addon) {
    this.#setState(addon?.isActive ? AdBlockerStates.ON : AdBlockerStates.OFF);
  }

  #setState(state) {
    this.#state = state;
    this.dispatchEvent(new CustomEvent("AdBlocker:StateChanged"));
    this.#updateButtons();
  }

  // AddonListener
  onEnabled(addon) {
    if (addon.id == UBO_ID) {
      this.#refreshState(addon);
    }
  }

  onDisabled(addon) {
    if (addon.id == UBO_ID) {
      this.#refreshState(addon);
    }
  }

  onUninstalled(addon) {
    if (addon.id == UBO_ID) {
      Services.prefs.setBoolPref(ENABLED_PREF, false);
      this.#setSponsoredPrefs(false);
      this.#refreshState(null);
    }
  }

  onInstalled(addon) {
    if (addon.id == UBO_ID) {
      this.#refreshState(addon);
    }
  }

  #createWidget() {
    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      l10nId: "adblock-button-off",
      type: "button",
      onCommand: () => this.toggle(),
      onCreated: node => this.#updateButton(node),
    });
    this.#widgetCreated = true;
    if (
      !Services.prefs.getBoolPref(ADDED_PREF, false) &&
      !lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID, false, true)
    ) {
      const vpn = lazy.CustomizableUI.getPlacementOfWidget("freevpn-button");
      lazy.CustomizableUI.addWidgetToArea(
        WIDGET_ID,
        lazy.CustomizableUI.AREA_NAVBAR,
        vpn ? vpn.position + 1 : null
      );
      Services.prefs.setBoolPref(ADDED_PREF, true);
    }
  }

  #updateButton(node) {
    const state = this.#state;
    node.setAttribute("adblock-state", state);
    node.style.listStyleImage = `url("${ICON_BASE}adblock-${
      state == AdBlockerStates.ON ? "on" : "off"
    }.svg")`;
    node.ownerDocument.l10n.setAttributes(node, `adblock-button-${state}`);
  }

  #updateButtons() {
    const widget = this.#widgetCreated
      ? lazy.CustomizableUI.getWidget(WIDGET_ID)
      : null;
    for (const instance of widget?.instances ?? []) {
      if (instance.node) {
        this.#updateButton(instance.node);
      }
    }
  }
}

export const AdBlocker = new AdBlockerService();

/**
 * Entry points registered in BrowserComponents.manifest.
 */
export const AdBlockerStartup = {
  init() {
    AdBlocker.init();
  },
  uninit() {
    AdBlocker.uninit();
  },
};
