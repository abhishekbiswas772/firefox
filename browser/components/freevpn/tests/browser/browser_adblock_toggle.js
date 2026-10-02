/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AdBlocker, AdBlockerStates, SPONSORED_PREFS, UBO_ID } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/freevpn/AdBlocker.sys.mjs"
  );

function waitForState(state) {
  return TestUtils.waitForCondition(
    () => AdBlocker.state == state,
    `Waiting for ad blocker state ${state}`
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.adblock.enabled", true]],
  });
  for (const pref of SPONSORED_PREFS) {
    Services.prefs.clearUserPref(pref);
  }
  Services.prefs.clearUserPref("browser.adblock.ownsSponsoredPrefs");
});

add_task(async function test_toggle() {
  // A stand-in with uBlock Origin's id, since tests cannot download add-ons.
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: UBO_ID } },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  await waitForState(AdBlockerStates.ON);

  const button = document.getElementById("adblock-button");
  ok(button, "Ad blocker toggle is in the toolbar");
  is(button.getAttribute("adblock-state"), "on", "Button shows on");

  button.click();
  await waitForState(AdBlockerStates.OFF);
  ok(
    !Services.prefs.getBoolPref("browser.adblock.enabled"),
    "Turning off is remembered"
  );
  ok(!(await AddonManager.getAddonByID(UBO_ID)).isActive, "Blocker disabled");
  is(button.getAttribute("adblock-state"), "off", "Button shows off");

  button.click();
  await waitForState(AdBlockerStates.ON);
  ok((await AddonManager.getAddonByID(UBO_ID)).isActive, "Blocker enabled");
  for (const pref of SPONSORED_PREFS) {
    ok(
      !Services.prefs.getBoolPref(pref, true),
      `${pref} is off while blocking ads`
    );
  }

  button.click();
  await waitForState(AdBlockerStates.OFF);
  for (const pref of SPONSORED_PREFS) {
    ok(
      !Services.prefs.prefHasUserValue(pref),
      `${pref} is back to its default`
    );
  }

  button.click();
  await waitForState(AdBlockerStates.ON);
  await extension.unload();
  await waitForState(AdBlockerStates.OFF);
});
