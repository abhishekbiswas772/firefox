/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { CHAT_SIDEBAR_ID, CLAUDE_URL } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/ClaudeButton.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

// Stands in for claude.ai, since tests cannot reach the network.
const TEST_PROVIDER = "http://mochi.test:8888/";

function isChatOpen() {
  return (
    SidebarController.isOpen && SidebarController.currentID == CHAT_SIDEBAR_ID
  );
}

async function hideSidebar() {
  if (SidebarController.isOpen) {
    await SidebarController.hide();
  }
}

add_setup(async function () {
  // Must be off before the provider changes, or the change opens the sidebar.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.chat.openSidebarOnProviderChange", false]],
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.ml.chat.enabled", true],
      ["browser.ml.chat.provider", TEST_PROVIDER],
      ["browser.ml.chat.page", false],
    ],
  });
  await hideSidebar();
  registerCleanupFunction(hideSidebar);
});

add_task(function test_defaults() {
  const defaults = Services.prefs.getDefaultBranch("");
  const bypass = defaults
    .getStringPref("browser.freevpn.bypassDomains")
    .split(",");
  ok(bypass.includes("claude.ai"), "Claude skips the VPN by default");
  ok(
    document.getElementById("claude-button"),
    "Claude button is in the toolbar"
  );
});

add_task(async function test_one_click_toggle() {
  const button = document.getElementById("claude-button");
  ok(!isChatOpen(), "Chat sidebar starts closed");
  ok(!button.hasAttribute("checked"), "Button starts unchecked");

  button.click();
  await TestUtils.waitForCondition(isChatOpen, "Chat sidebar opens");
  await TestUtils.waitForCondition(
    () => button.hasAttribute("checked"),
    "Button shows the sidebar is open"
  );
  is(
    button.getAttribute("data-l10n-id"),
    "claude-button-open",
    "Tooltip offers to close Claude"
  );

  button.click();
  await TestUtils.waitForCondition(() => !isChatOpen(), "Chat sidebar closes");
  await TestUtils.waitForCondition(
    () => !button.hasAttribute("checked"),
    "Button shows the sidebar is closed"
  );
});

add_task(async function test_button_tracks_shortcut_and_other_sidebars() {
  const button = document.getElementById("claude-button");

  await SidebarController.show(CHAT_SIDEBAR_ID);
  await TestUtils.waitForCondition(
    () => button.hasAttribute("checked"),
    "Opening the chatbot another way checks the button"
  );

  await SidebarController.show("viewBookmarksSidebar");
  await TestUtils.waitForCondition(
    () => !button.hasAttribute("checked"),
    "Switching to another sidebar unchecks the button"
  );
  await SidebarController.hide();
});

add_task(async function test_unset_provider_becomes_claude() {
  // An open chatbot sidebar would load the new provider, which tests cannot.
  await hideSidebar();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ml.chat.provider", ""]],
  });
  const toggle = sinon.stub(SidebarController, "toggle").resolves();
  try {
    document.getElementById("claude-button").click();
    await TestUtils.waitForCondition(() => toggle.called, "Sidebar toggled");
    is(
      Services.prefs.getStringPref("browser.ml.chat.provider"),
      CLAUDE_URL,
      "Claude is chosen when no chatbot was picked"
    );
    is(toggle.firstCall.args[0], CHAT_SIDEBAR_ID, "Toggles the chatbot");

    toggle.resetHistory();
    Services.prefs.setStringPref("browser.ml.chat.provider", TEST_PROVIDER);
    document.getElementById("claude-button").click();
    await TestUtils.waitForCondition(() => toggle.called, "Toggled again");
    is(
      Services.prefs.getStringPref("browser.ml.chat.provider"),
      TEST_PROVIDER,
      "A chatbot the user chose is kept"
    );
  } finally {
    toggle.restore();
  }
  await SpecialPowers.popPrefEnv();
});
