/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  FREEVPN_COUNTRIES: "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs",
  FreeVPN: "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs",
  FreeVPNProviders: "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs",
  FreeVPNStates: "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const WIDGET_ID = "freevpn-button";
const PANEL_ID = "PanelUI-freevpn";
const PREF_BRANCH = "browser.freevpn.";
const TOR_CHECK_PAGE = "https://check.torproject.org/";
const ICON_BASE = "chrome://browser/content/freevpn/";
const BRIDGE_TYPES = ["auto", "none", "snowflake", "obfs4", "meek", "custom"];

// Checkbox id -> boolean pref name under browser.freevpn., and its default.
const BOOL_PREFS = {
  "kill-switch": ["killSwitch", true],
  "battery-saver": ["batterySaver", true],
  "auto-connect": ["autoConnect", false],
};

const ICONS = {
  on: "on",
  connecting: "connecting",
  error: "error",
};

const BUTTON_L10N = {
  on: "freevpn-button-on",
  connecting: "freevpn-button-connecting",
  error: "freevpn-button-error",
};

function iconURL(state) {
  return `${ICON_BASE}freevpn-${ICONS[state] ?? "off"}.svg`;
}

function getString(pref, fallback) {
  return Services.prefs.getStringPref(PREF_BRANCH + pref, fallback);
}

/**
 * Returns the site a tab is showing, as used for split tunneling.
 *
 * @param {Window} win - A browser window.
 * @returns {string} The registrable domain, or "" for non-web pages.
 */
export function currentSite(win) {
  const uri = win.gBrowser?.selectedBrowser?.currentURI;
  if (!uri?.schemeIs("http") && !uri?.schemeIs("https")) {
    return "";
  }
  try {
    return Services.eTLD.getBaseDomain(uri);
  } catch (e) {
    return uri.host;
  }
}

/**
 * Builds and updates the contents of the free VPN panel for one window.
 */
class FreeVPNPanel {
  /** @type {Map<string, Element>} */
  #els = new Map();
  #built = false;

  /**
   * @param {Element} panelview
   */
  constructor(panelview) {
    this.panelview = panelview;
    this.doc = panelview.ownerDocument;
  }

  #el(tag, attrs = {}, parent = null) {
    const el = this.doc.createElementNS(HTML_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key == "id") {
        this.#els.set(value, el);
        el.id = `freevpn-${value}`;
      } else if (key == "l10n") {
        this.doc.l10n.setAttributes(el, value.id, value.args);
      } else if (value === true) {
        el.setAttribute(key, "");
      } else if (value !== false && value !== null && value !== undefined) {
        el.setAttribute(key, value);
      }
    }
    parent?.append(el);
    return el;
  }

  #get(id) {
    return this.#els.get(id);
  }

  #select(id, l10nId, options, pref, parent) {
    const select = this.#el("moz-select", { id, l10n: { id: l10nId } }, parent);
    for (const option of options) {
      this.#el("moz-option", option, select);
    }
    select.addEventListener("change", () =>
      Services.prefs.setStringPref(PREF_BRANCH + pref, select.value)
    );
    return select;
  }

  build() {
    if (this.#built) {
      return;
    }
    this.#built = true;
    const body = this.panelview.querySelector("#PanelUI-freevpn-content");

    const status = this.#el(
      "div",
      { id: "status", class: "freevpn-section" },
      body
    );
    this.#el("img", { id: "status-icon", alt: "" }, status);
    const statusText = this.#el(
      "div",
      { class: "freevpn-status-text" },
      status
    );
    this.#el("h2", { id: "status-title" }, statusText);
    this.#el("p", { id: "status-detail" }, statusText);
    this.#el(
      "moz-toggle",
      { id: "toggle", l10n: { id: "freevpn-toggle" } },
      status
    ).addEventListener("toggle", () => lazy.FreeVPN.toggle());

    this.#el("progress", { id: "progress", max: "100", value: "0" }, body);
    this.#el("moz-message-bar", { id: "error", type: "error" }, body);

    const siteBypass = this.#el("moz-checkbox", { id: "site-bypass" }, body);
    siteBypass.addEventListener("change", () => {
      const win = this.doc.ownerGlobal;
      const site = currentSite(win);
      if (site) {
        lazy.FreeVPN.setBypassed(site, siteBypass.checked);
        win.gBrowser.reload();
      }
    });

    const actions = this.#el("div", { class: "freevpn-actions" }, body);
    this.#el(
      "moz-button",
      { id: "new-identity", l10n: { id: "freevpn-new-identity" } },
      actions
    ).addEventListener("click", () => lazy.FreeVPN.newIdentity());
    this.#el(
      "moz-button",
      { id: "check-ip", type: "ghost", l10n: { id: "freevpn-check-ip" } },
      actions
    ).addEventListener("click", () => {
      this.doc.ownerGlobal.openTrustedLinkIn(TOR_CHECK_PAGE, "tab");
      lazy.CustomizableUI.hidePanelForNode(this.panelview);
    });

    body.append(this.doc.createXULElement("toolbarseparator"));

    const settings = this.#el("div", { class: "freevpn-settings" }, body);

    this.#select(
      "provider",
      "freevpn-provider",
      [
        [lazy.FreeVPNProviders.TOR, "freevpn-provider-tor"],
        [lazy.FreeVPNProviders.TOR_SYSTEM, "freevpn-provider-tor-system"],
        [lazy.FreeVPNProviders.CUSTOM, "freevpn-provider-custom"],
      ].map(([value, id]) => ({ value, l10n: { id } })),
      "provider",
      settings
    );

    const regionNames = new Services.intl.DisplayNames(undefined, {
      type: "region",
    });
    const countries = lazy.FREEVPN_COUNTRIES.map(code => ({
      value: code,
      label: regionNames.of(code.toUpperCase()),
    })).sort((a, b) => a.label.localeCompare(b.label));
    this.#select(
      "location",
      "freevpn-location",
      [{ value: "", l10n: { id: "freevpn-location-auto" } }, ...countries],
      "exitCountry",
      settings
    );

    this.#select(
      "bridges",
      "freevpn-bridges",
      BRIDGE_TYPES.map(value => ({
        value,
        l10n: { id: `freevpn-bridges-${value}` },
      })),
      "tor.bridgeType",
      settings
    );

    const custom = this.#el("div", { id: "custom" }, settings);
    this.#select(
      "custom-type",
      "freevpn-custom-type",
      ["socks", "http", "https"].map(value => ({
        value,
        l10n: { id: `freevpn-custom-type-${value}` },
      })),
      "custom.type",
      custom
    );
    const customHost = this.#el(
      "moz-input-text",
      {
        id: "custom-host",
        placeholder: "127.0.0.1",
        l10n: { id: "freevpn-custom-host" },
      },
      custom
    );
    customHost.addEventListener("change", () =>
      Services.prefs.setStringPref(
        PREF_BRANCH + "custom.host",
        customHost.value.trim()
      )
    );
    const customPort = this.#el(
      "moz-input-number",
      {
        id: "custom-port",
        min: "1",
        max: "65535",
        l10n: { id: "freevpn-custom-port" },
      },
      custom
    );
    customPort.addEventListener("change", () => {
      const port = parseInt(customPort.value, 10);
      if (port > 0 && port <= 65535) {
        Services.prefs.setIntPref(PREF_BRANCH + "custom.port", port);
      }
    });

    const privateOnly = this.#el(
      "moz-checkbox",
      { id: "private-only", l10n: { id: "freevpn-private-only" } },
      settings
    );
    privateOnly.addEventListener("change", () =>
      Services.prefs.setStringPref(
        PREF_BRANCH + "mode",
        privateOnly.checked ? "private" : "all"
      )
    );
    for (const [id, [pref]] of Object.entries(BOOL_PREFS)) {
      const checkbox = this.#el(
        "moz-checkbox",
        { id, l10n: { id: `freevpn-${id}` } },
        settings
      );
      checkbox.addEventListener("change", () =>
        Services.prefs.setBoolPref(PREF_BRANCH + pref, checkbox.checked)
      );
    }

    this.#el(
      "p",
      { class: "freevpn-footer", l10n: { id: "freevpn-footer" } },
      body
    );
  }

  update() {
    if (!this.#built) {
      return;
    }
    const { FreeVPN, FreeVPNProviders } = lazy;
    const FreeVPNStates = lazy.FreeVPNStates;
    const state = FreeVPN.state;
    const l10n = this.doc.l10n;
    const providerId = FreeVPN.provider;

    this.panelview.setAttribute("freevpn-state", state);
    this.#get("status-icon").src = iconURL(state);
    this.#get("toggle").pressed =
      state == FreeVPNStates.ON || state == FreeVPNStates.CONNECTING;

    l10n.setAttributes(this.#get("status-title"), `freevpn-status-${state}`);
    this.#updateDetail(state, providerId);

    const progress = this.#get("progress");
    progress.hidden = state != FreeVPNStates.CONNECTING;
    progress.value = FreeVPN.progress;

    const error = this.#get("error");
    error.hidden = !FreeVPN.error;
    if (FreeVPN.error) {
      l10n.setAttributes(error, `freevpn-error-${FreeVPN.error.code}`, {
        detail: FreeVPN.error.detail,
      });
    }

    const site = currentSite(this.doc.ownerGlobal);
    const siteBypass = this.#get("site-bypass");
    siteBypass.hidden = !site;
    if (site) {
      l10n.setAttributes(siteBypass, "freevpn-site-bypass", { site });
      siteBypass.checked = FreeVPN.isBypassed(site);
    }

    this.#get("new-identity").hidden = !(
      state == FreeVPNStates.ON && FreeVPN.usesTor
    );
    this.#get("check-ip").hidden = state != FreeVPNStates.ON;

    this.#setIfIdle("provider", providerId);
    const isManagedTor = providerId == FreeVPNProviders.TOR;
    this.#get("location").hidden = !isManagedTor;
    this.#get("bridges").hidden = !isManagedTor;
    this.#setIfIdle("location", getString("exitCountry", ""));
    this.#setIfIdle("bridges", getString("tor.bridgeType", "auto"));

    this.#get("custom").hidden = providerId != FreeVPNProviders.CUSTOM;
    this.#setIfIdle("custom-type", getString("custom.type", "socks"));
    this.#setIfIdle("custom-host", getString("custom.host", ""));
    this.#setIfIdle(
      "custom-port",
      String(Services.prefs.getIntPref(PREF_BRANCH + "custom.port", 1080))
    );

    this.#get("private-only").checked = getString("mode", "all") == "private";
    for (const [id, [pref, fallback]] of Object.entries(BOOL_PREFS)) {
      this.#get(id).checked = Services.prefs.getBoolPref(
        PREF_BRANCH + pref,
        fallback
      );
    }
  }

  #updateDetail(state, providerId) {
    const FreeVPN = lazy.FreeVPN;
    const FreeVPNStates = lazy.FreeVPNStates;
    const detail = this.#get("status-detail");
    const l10n = this.doc.l10n;
    switch (state) {
      case FreeVPNStates.CONNECTING:
        l10n.setAttributes(
          detail,
          FreeVPN.bridgeInUse == "none"
            ? "freevpn-detail-connecting"
            : "freevpn-detail-connecting-bridge",
          { percent: FreeVPN.progress, bridge: FreeVPN.bridgeInUse }
        );
        break;
      case FreeVPNStates.ON:
        if (FreeVPN.exitInfo?.ip) {
          l10n.setAttributes(detail, "freevpn-detail-on-ip", {
            ip: FreeVPN.exitInfo.ip,
          });
        } else {
          l10n.setAttributes(detail, "freevpn-detail-on");
        }
        break;
      case FreeVPNStates.ERROR:
        l10n.setAttributes(
          detail,
          Services.prefs.getBoolPref(PREF_BRANCH + "killSwitch", true)
            ? "freevpn-detail-error-blocked"
            : "freevpn-detail-error"
        );
        break;
      default:
        l10n.setAttributes(detail, `freevpn-detail-off-${providerId}`);
    }
  }

  /**
   * Updates a form control unless it has focus, so typing is not clobbered.
   *
   * @param {string} id - Element key passed to #el.
   * @param {string} value - The new value.
   */
  #setIfIdle(id, value) {
    const el = this.#get(id);
    if (!el.matches(":focus-within")) {
      el.value = value;
    }
  }
}

/**
 * Owns the "Free VPN" toolbar button and its panel in every window. Clicking
 * the button turns the VPN on or off; the arrow next to it opens the panel.
 */
export const FreeVPNWidget = {
  WIDGET_ID,
  PANEL_ID,
  created: false,
  /** @type {WeakMap<Window, FreeVPNPanel>} */
  panels: new WeakMap(),

  init() {
    if (this.created) {
      return;
    }
    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      l10nId: "freevpn-button",
      type: "button-and-view",
      viewId: PANEL_ID,
      disallowSubView: true,
      defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
      onCommand: () => lazy.FreeVPN.toggle(),
      onViewShowing: event => this.onViewShowing(event),
      onCreated: node => this.updateButton(node),
    });
    this.created = true;
    lazy.FreeVPN.addEventListener("FreeVPN:StateChanged", this);
    Services.prefs.addObserver(PREF_BRANCH, this);
  },

  uninit() {
    if (!this.created) {
      return;
    }
    lazy.FreeVPN.removeEventListener("FreeVPN:StateChanged", this);
    Services.prefs.removeObserver(PREF_BRANCH, this);
    lazy.CustomizableUI.destroyWidget(WIDGET_ID);
    this.panels = new WeakMap();
    this.created = false;
  },

  onViewShowing(event) {
    const panelview = event.target;
    const win = panelview.ownerGlobal;
    let panel = this.panels.get(win);
    if (!panel || panel.panelview != panelview) {
      panel = new FreeVPNPanel(panelview);
      this.panels.set(win, panel);
    }
    panel.build();
    panel.update();
  },

  /**
   * @param {Element} node - The widget's toolbaritem.
   */
  updateButton(node) {
    const state = lazy.FreeVPN.state;
    const doc = node.ownerDocument;
    if (!doc?.l10n) {
      return;
    }
    node.setAttribute("freevpn-state", state);
    const button =
      node.querySelector(`#${WIDGET_ID}-button`) ??
      doc.getElementById(`${WIDGET_ID}-button`) ??
      node;
    button.style.listStyleImage = `url("${iconURL(state)}")`;
    doc.l10n.setAttributes(button, BUTTON_L10N[state] ?? "freevpn-button");
    const dropmarker = node.querySelector(`#${WIDGET_ID}-dropmarker`);
    if (dropmarker) {
      doc.l10n.setAttributes(dropmarker, "freevpn-dropmarker");
    }
  },

  updateAll() {
    const widget = lazy.CustomizableUI.getWidget(WIDGET_ID);
    if (!widget) {
      return;
    }
    for (const instance of widget.instances) {
      if (instance.node) {
        this.updateButton(instance.node);
      }
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      this.panels.get(win)?.update();
    }
  },

  handleEvent() {
    this.updateAll();
  },

  observe(subject, topic) {
    if (topic == "nsPref:changed") {
      this.updateAll();
    }
  },
};
