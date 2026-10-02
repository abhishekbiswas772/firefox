/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { FreeVPN, FreeVPNStates } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs"
);

const TEST_PATH = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  // The test proxy below only speaks plain HTTP.
  // eslint-disable-next-line sdl/no-insecure-url
  "http://example.com"
);
const CHECK_URL = TEST_PATH + "check_ip.json";
// The mochitest web server doubles as an HTTP proxy for its test hosts.
const TEST_PROXY_PORT = 8888;
// Nothing listens here, so connecting to the "VPN" fails.
const DEAD_PROXY_PORT = 1;

function waitForState(state) {
  return TestUtils.waitForCondition(
    () => FreeVPN.state == state,
    `Waiting for VPN state ${state}`
  );
}

async function canFetch(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.ok;
  } catch (e) {
    return false;
  }
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.freevpn.provider", "custom"],
      ["browser.freevpn.custom.type", "http"],
      ["browser.freevpn.custom.host", "127.0.0.1"],
      ["browser.freevpn.custom.port", TEST_PROXY_PORT],
      ["browser.freevpn.checkUrl", CHECK_URL],
      ["browser.freevpn.killSwitch", true],
      ["browser.freevpn.mode", "all"],
      ["browser.freevpn.bypassDomains", ""],
    ],
  });
  registerCleanupFunction(() => FreeVPN.disconnect());
});

add_task(async function test_widget_present() {
  info(
    `platform=${AppConstants.platform} enabled=${Services.prefs.getBoolPref(
      "browser.freevpn.enabled",
      false
    )} supported=${FreeVPN.isSupportedPlatform} state=${FreeVPN.state}`
  );
  is(FreeVPN.state, FreeVPNStates.OFF, "VPN starts off");
  const item = document.getElementById("freevpn-button");
  ok(item, "Toolbar item exists");
  ok(
    document.getElementById("freevpn-button-button"),
    "One-click toggle button exists"
  );
  ok(
    document.getElementById("freevpn-button-dropmarker"),
    "Settings dropmarker exists"
  );
  is(item.getAttribute("freevpn-state"), "off", "Button shows off");
});

add_task(async function test_one_click_toggle() {
  const webrtcPref = "media.peerconnection.ice.proxy_only_if_behind_proxy";
  const before = Services.prefs.getBoolPref(webrtcPref, false);

  document.getElementById("freevpn-button-button").click();
  await waitForState(FreeVPNStates.ON);
  is(FreeVPN.exitInfo?.ip, "203.0.113.7", "Exit IP comes from the check URL");
  is(
    document.getElementById("freevpn-button").getAttribute("freevpn-state"),
    "on",
    "Button shows on"
  );
  ok(
    Services.prefs.getBoolPref(webrtcPref),
    "WebRTC is limited to the proxy while connected"
  );
  ok(await canFetch(CHECK_URL), "Pages load through the tunnel");

  document.getElementById("freevpn-button-button").click();
  await waitForState(FreeVPNStates.OFF);
  is(
    Services.prefs.getBoolPref(webrtcPref, false),
    before,
    "WebRTC pref is restored"
  );
});

add_task(async function test_panel() {
  FreeVPN.connect();
  await waitForState(FreeVPNStates.ON);

  const panelShown = BrowserTestUtils.waitForEvent(
    document,
    "ViewShown",
    false,
    e => e.target.id == "PanelUI-freevpn"
  );
  document.getElementById("freevpn-button-dropmarker").click();
  await panelShown;

  const toggle = document.getElementById("freevpn-toggle");
  ok(toggle.pressed, "Panel toggle is on");
  is(
    document
      .getElementById("freevpn-status-title")
      .getAttribute("data-l10n-id"),
    "freevpn-status-on",
    "Panel shows the on status"
  );
  is(
    document.getElementById("freevpn-provider").value,
    "custom",
    "Provider select reflects the pref"
  );
  ok(
    BrowserTestUtils.isHidden(document.getElementById("freevpn-location")),
    "Tor location is hidden for a custom proxy"
  );
  ok(
    BrowserTestUtils.isVisible(document.getElementById("freevpn-custom")),
    "Custom proxy fields are shown"
  );

  const panel = document.getElementById("PanelUI-freevpn").closest("panel");
  const hidden = BrowserTestUtils.waitForEvent(panel, "popuphidden");
  panel.hidePopup();
  await hidden;

  FreeVPN.disconnect();
  await waitForState(FreeVPNStates.OFF);
});

add_task(async function test_kill_switch_and_split_tunnel() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.freevpn.custom.port", DEAD_PROXY_PORT]],
  });

  FreeVPN.connect();
  await waitForState(FreeVPNStates.ERROR);
  is(FreeVPN.error?.code, "proxy-unreachable", "Reports the dead proxy");

  ok(!(await canFetch(CHECK_URL)), "Kill switch blocks tunneled traffic");

  FreeVPN.setBypassed("example.org", true);
  ok(FreeVPN.isBypassed("example.org"), "Site was added to split tunneling");
  const bypassedUrl = CHECK_URL.replace("example.com", "example.org");
  ok(
    await canFetch(bypassedUrl),
    "Split-tunneled site uses the normal connection"
  );
  ok(!(await canFetch(CHECK_URL)), "Other sites stay blocked");
  FreeVPN.setBypassed("example.org", false);

  FreeVPN.disconnect();
  await waitForState(FreeVPNStates.OFF);
  ok(await canFetch(CHECK_URL), "Normal browsing resumes after turning off");

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_private_only_mode() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.freevpn.custom.port", DEAD_PROXY_PORT],
      ["browser.freevpn.mode", "private"],
    ],
  });

  FreeVPN.connect();
  await waitForState(FreeVPNStates.ERROR);
  // The exit check host is always tunneled, so probe a different site.
  ok(
    await canFetch(CHECK_URL.replace("example.com", "example.org")),
    "Normal windows are not tunneled in private-only mode"
  );

  FreeVPN.disconnect();
  await waitForState(FreeVPNStates.OFF);
  await SpecialPowers.popPrefEnv();
});
