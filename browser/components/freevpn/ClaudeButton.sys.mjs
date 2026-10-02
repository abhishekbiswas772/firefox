/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  EveryWindow: "resource:///modules/EveryWindow.sys.mjs",
});

export const CLAUDE_URL = "https://claude.ai/new";
export const CHAT_SIDEBAR_ID = "viewGenaiChatSidebar";
const WIDGET_ID = "claude-button";
const FEATURE_PREF = "browser.claude.button.enabled";
const PROVIDER_PREF = "browser.ml.chat.provider";
const CHAT_ENABLED_PREF = "browser.ml.chat.enabled";
const EVERY_WINDOW_ID = "claude-button";

/**
 * A one-click toolbar button that opens Claude (claude.ai) in Firefox's AI
 * chatbot sidebar, next to the page. The sidebar, its "summarize page" and
 * selection prompts, and the Ctrl+Alt+X shortcut are Firefox's own. The first
 * click chooses Claude as the chatbot if none was chosen yet; a different
 * choice made in the sidebar is kept.
 */
export const ClaudeButton = {
  _inited: false,
  /** @type {WeakMap<Window, MutationObserver>} */
  _observers: new WeakMap(),

  init() {
    if (this._inited || !Services.prefs.getBoolPref(FEATURE_PREF, true)) {
      return;
    }
    this._inited = true;
    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      l10nId: "claude-button",
      type: "button",
      defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
      onCommand: event => this.toggle(event.view),
      onCreated: node => this.updateButton(node.documentGlobal),
    });
    lazy.EveryWindow.registerCallback(
      EVERY_WINDOW_ID,
      win => this.trackWindow(win),
      win => this.untrackWindow(win)
    );
  },

  uninit() {
    if (!this._inited) {
      return;
    }
    this._inited = false;
    lazy.EveryWindow.unregisterCallback(EVERY_WINDOW_ID);
    this._observers = new WeakMap();
    lazy.CustomizableUI.destroyWidget(WIDGET_ID);
  },

  /**
   * Opens or closes Claude in the sidebar of a browser window.
   *
   * @param {Window} win
   */
  async toggle(win) {
    if (!Services.prefs.getBoolPref(CHAT_ENABLED_PREF, true)) {
      Services.prefs.setBoolPref(CHAT_ENABLED_PREF, true);
    }
    if (!Services.prefs.getStringPref(PROVIDER_PREF, "")) {
      Services.prefs.setStringPref(PROVIDER_PREF, CLAUDE_URL);
    }
    await win.SidebarController.toggle(CHAT_SIDEBAR_ID);
    this.updateButton(win);
  },

  /**
   * @param {Window} win
   * @returns {boolean} True if the chatbot sidebar is showing.
   */
  isOpen(win) {
    const sidebar = win.SidebarController;
    return !!sidebar?.isOpen && sidebar.currentID == CHAT_SIDEBAR_ID;
  },

  /**
   * Called by EveryWindow for every current and future browser window.
   *
   * @param {Window} win
   */
  trackWindow(win) {
    if (this._observers.has(win)) {
      this.updateButton(win);
      return;
    }
    // The sidebar has no single "changed" event: listen to showing, to the
    // box being hidden or shown, and to the revamped sidebar switching panels.
    win.addEventListener("SidebarShown", this);
    const box = win.document.getElementById("sidebar-box");
    if (box) {
      box.addEventListener("sidebar-show", this);
      const observer = new win.MutationObserver(() => this.scheduleUpdate(win));
      observer.observe(box, {
        attributes: true,
        attributeFilter: ["hidden", "checked"],
      });
      this._observers.set(win, observer);
    }
    this.updateButton(win);
  },

  /**
   * @param {Window} win
   */
  untrackWindow(win) {
    this._observers.get(win)?.disconnect();
    this._observers.delete(win);
    win.removeEventListener("SidebarShown", this);
    win.document
      .getElementById("sidebar-box")
      ?.removeEventListener("sidebar-show", this);
  },

  /**
   * Updates the button once the sidebar has finished switching, since some
   * signals arrive before SidebarController's state is updated.
   *
   * @param {Window} win
   */
  scheduleUpdate(win) {
    if (!win || win.closed) {
      return;
    }
    win.setTimeout(() => {
      if (!win.closed) {
        this.updateButton(win);
      }
    }, 0);
  },

  updateButton(win) {
    const node = win?.document?.getElementById(WIDGET_ID);
    if (!node) {
      return;
    }
    const open = this.isOpen(win);
    node.toggleAttribute("checked", open);
    win.document.l10n.setAttributes(
      node,
      open ? "claude-button-open" : "claude-button"
    );
  },

  handleEvent(event) {
    const win = event.currentTarget.documentGlobal ?? event.currentTarget;
    this.scheduleUpdate(win);
  },
};

/**
 * Entry points registered in BrowserComponents.manifest.
 */
export const ClaudeButtonStartup = {
  init() {
    ClaudeButton.init();
  },
  uninit() {
    ClaudeButton.uninit();
  },
};
