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
const ADDED_PREF = "browser.freevpn.widgetAdded";
const PREF_BRANCH = "browser.freevpn.";
const TOR_CHECK_PAGE = "https://check.torproject.org/";
const ICON_BASE = "chrome://browser/content/freevpn/";

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
        this.doc.l10n.setAttributes(el, value);
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
    const toggle = this.#el(
      "moz-toggle",
      { id: "toggle", l10n: { id: "freevpn-toggle" } },
      status
    );
    toggle.addEventListener("toggle", () => lazy.FreeVPN.toggle());

    this.#el("progress", { id: "progress", max: "100", value: "0" }, body);

    this.#el("moz-message-bar", { id: "error", type: "error" }, body);

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

    const provider = this.#el(
      "moz-select",
      { id: "provider", l10n: { id: "freevpn-provider" } },
      settings
    );
    for (const [value, l10nId] of [
      [lazy.FreeVPNProviders.TOR, "freevpn-provider-tor"],
      [lazy.FreeVPNProviders.TOR_SYSTEM, "freevpn-provider-tor-system"],
      [lazy.FreeVPNProviders.CUSTOM, "freevpn-provider-custom"],
    ]) {
      this.#el("moz-option", { value, l10n: { id: l10nId } }, provider);
    }
    provider.addEventListener("change", () =>
      Services.prefs.setStringPref(PREF_BRANCH + "provider", provider.value)
    );

    const location = this.#el(
      "moz-select",
      { id: "location", l10n: { id: "freevpn-location" } },
      settings
    );
    this.#el(
      "moz-option",
      { value: "", l10n: { id: "freevpn-location-auto" } },
      location
    );
    const regionNames = new Services.intl.DisplayNames(undefined, {
      type: "region",
    });
    const countries = lazy.FREEVPN_COUNTRIES.map(code => ({
      code,
      name: regionNames.of(code.toUpperCase()),
    })).sort((a, b) => a.name.localeCompare(b.name));
    for (const { code, name } of countries) {
      this.#el("moz-option", { value: code, label: name }, location);
    }
    location.addEventListener("change", () =>
      Services.prefs.setStringPref(PREF_BRANCH + "exitCountry", location.value)
    );

    const custom = this.#el("div", { id: "custom" }, settings);
    const customType = this.#el(
      "moz-select",
      { id: "custom-type", l10n: { id: "freevpn-custom-type" } },
      custom
    );
    for (const value of ["socks", "http", "https"]) {
      this.#el(
        "moz-option",
        { value, l10n: { id: `freevpn-custom-type-${value}` } },
        customType
      );
    }
    customType.addEventListener("change", () =>
      Services.prefs.setStringPref(
        PREF_BRANCH + "custom.type",
        customType.value
      )
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

    for (const [id, pref, l10nId] of [
      ["private-only", "mode", "freevpn-private-only"],
      ["kill-switch", "killSwitch", "freevpn-kill-switch"],
      ["auto-connect", "autoConnect", "freevpn-auto-connect"],
    ]) {
      const checkbox = this.#el(
        "moz-checkbox",
        { id, l10n: { id: l10nId } },
        settings
      );
      checkbox.addEventListener("change", () => {
        if (pref == "mode") {
          Services.prefs.setStringPref(
            PREF_BRANCH + "mode",
            checkbox.checked ? "private" : "all"
          );
        } else {
          Services.prefs.setBoolPref(PREF_BRANCH + pref, checkbox.checked);
        }
      });
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
    const { FreeVPN, FreeVPNStates, FreeVPNProviders } = lazy;
    const state = FreeVPN.state;
    const l10n = this.doc.l10n;
    const providerId = FreeVPN.provider;

    this.panelview.setAttribute("freevpn-state", state);
    this.#get("status-icon").src = `${ICON_BASE}freevpn-${iconFor(state)}.svg`;

    const toggle = this.#get("toggle");
    toggle.pressed =
      state == FreeVPNStates.ON || state == FreeVPNStates.CONNECTING;

    l10n.setAttributes(this.#get("status-title"), `freevpn-status-${state}`);
    const detail = this.#get("status-detail");
    if (state == FreeVPNStates.CONNECTING) {
      l10n.setAttributes(detail, "freevpn-detail-connecting", {
        percent: FreeVPN.progress,
      });
    } else if (state == FreeVPNStates.ON && FreeVPN.exitInfo?.ip) {
      l10n.setAttributes(detail, "freevpn-detail-on-ip", {
        ip: FreeVPN.exitInfo.ip,
      });
    } else if (state == FreeVPNStates.ON) {
      l10n.setAttributes(detail, "freevpn-detail-on");
    } else if (state == FreeVPNStates.ERROR) {
      l10n.setAttributes(
        detail,
        Services.prefs.getBoolPref(PREF_BRANCH + "killSwitch", true)
          ? "freevpn-detail-error-blocked"
          : "freevpn-detail-error"
      );
    } else {
      l10n.setAttributes(detail, `freevpn-detail-off-${providerId}`);
    }

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

    this.#get("new-identity").hidden = !(
      state == FreeVPNStates.ON && FreeVPN.usesTor
    );
    this.#get("check-ip").hidden = state != FreeVPNStates.ON;

    this.#setIfIdle("provider", providerId);
    this.#get("location").hidden = providerId != FreeVPNProviders.TOR;
    this.#setIfIdle(
      "location",
      Services.prefs.getStringPref(PREF_BRANCH + "exitCountry", "")
    );

    this.#get("custom").hidden = providerId != FreeVPNProviders.CUSTOM;
    this.#setIfIdle(
      "custom-type",
      Services.prefs.getStringPref(PREF_BRANCH + "custom.type", "socks")
    );
    this.#setIfIdle(
      "custom-host",
      Services.prefs.getStringPref(PREF_BRANCH + "custom.host", "")
    );
    this.#setIfIdle(
      "custom-port",
      String(Services.prefs.getIntPref(PREF_BRANCH + "custom.port", 1080))
    );

    this.#get("private-only").checked =
      Services.prefs.getStringPref(PREF_BRANCH + "mode", "all") == "private";
    this.#get("kill-switch").checked = Services.prefs.getBoolPref(
      PREF_BRANCH + "killSwitch",
      true
    );
    this.#get("auto-connect").checked = Services.prefs.getBoolPref(
      PREF_BRANCH + "autoConnect",
      false
    );
  }

  /**
   * Updates a form control unless it has focus, so typing is not clobbered.
   */
  #setIfIdle(id, value) {
    const el = this.#get(id);
    if (!el.matches(":focus-within")) {
      el.value = value;
    }
  }
}

function iconFor(state) {
  switch (state) {
    case lazy.FreeVPNStates.ON:
      return "on";
    case lazy.FreeVPNStates.CONNECTING:
      return "connecting";
    case lazy.FreeVPNStates.ERROR:
      return "error";
    default:
      return "off";
  }
}

/**
 * Owns the "Free VPN" toolbar button and its panel in every window.
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
      type: "view",
      viewId: PANEL_ID,
      disallowSubView: true,
      onViewShowing: event => this.onViewShowing(event),
      onCreated: node => this.updateButton(node),
    });
    this.created = true;
    this.placeWidget();
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

  placeWidget() {
    if (
      Services.prefs.getBoolPref(ADDED_PREF, false) ||
      lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID, false, true)
    ) {
      return;
    }
    const fxa = lazy.CustomizableUI.getPlacementOfWidget(
      "fxa-toolbar-menu-button"
    );
    lazy.CustomizableUI.addWidgetToArea(
      WIDGET_ID,
      lazy.CustomizableUI.AREA_NAVBAR,
      fxa ? fxa.position : null
    );
    Services.prefs.setBoolPref(ADDED_PREF, true);
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

  updateButton(node) {
    const state = lazy.FreeVPN.state;
    node.setAttribute("freevpn-state", state);
    node.style.listStyleImage = `url("${ICON_BASE}freevpn-${iconFor(state)}.svg")`;
    const l10nId =
      state == lazy.FreeVPNStates.ON
        ? "freevpn-button-on"
        : state == lazy.FreeVPNStates.CONNECTING
          ? "freevpn-button-connecting"
          : state == lazy.FreeVPNStates.ERROR
            ? "freevpn-button-error"
            : "freevpn-button";
    node.ownerDocument.l10n.setAttributes(node, l10nId);
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
