/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ChromeWebStore, NOTIFICATION_ID } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/ChromeWebStore.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const CRX_ID = "bcdefghijklmnopabcdefghijklmnopa";
const STORE_URL = `https://chromewebstore.google.com/detail/sample/${CRX_ID}`;

function stringStream(text) {
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  stream.setUTF8Data(text);
  return stream;
}

// Builds a CRX3 package around a small Manifest V3 extension.
async function makeCrx() {
  const path = PathUtils.join(PathUtils.tempDir, "cws-browser-test.zip");
  const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  writer.open(new FileUtils.File(path), 0x04 | 0x08 | 0x20);
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Store extension",
      version: "1.0",
      update_url: "https://clients2.google.com/service/update2/crx",
      background: { service_worker: "sw.js" },
      permissions: ["storage", "offscreen"],
    }),
    "sw.js": "self.started = true;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    writer.addEntryStream(
      name,
      Date.now() * 1000,
      Ci.nsIZipWriter.COMPRESSION_DEFAULT,
      stringStream(text),
      false
    );
  }
  writer.close();
  const zip = await IOUtils.read(path);
  await IOUtils.remove(path);

  const out = new Uint8Array(12 + zip.length);
  out.set([0x43, 0x72, 0x32, 0x34], 0);
  new DataView(out.buffer).setUint32(4, 3, true);
  out.set(zip, 12);
  return out.buffer;
}

function promisePermissionPrompt() {
  return new Promise(resolve => {
    const onShown = () => {
      if (
        PopupNotifications.getNotification("addon-webext-permissions") &&
        PopupNotifications.panel.state == "open"
      ) {
        PopupNotifications.panel.removeEventListener("popupshown", onShown);
        resolve(PopupNotifications.panel.firstElementChild);
      }
    };
    PopupNotifications.panel.addEventListener("popupshown", onShown);
  });
}

async function closePopupNotifications() {
  if (PopupNotifications.panel.state != "closed") {
    const hidden = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popuphidden"
    );
    PopupNotifications.panel.hidePopup();
    await hidden;
  }
}

add_task(async function test_offer_bar() {
  const browser = gBrowser.selectedBrowser;
  const box = gBrowser.getNotificationBox(browser);

  ChromeWebStore.onLocationChange(browser, Services.io.newURI(STORE_URL));
  const notification = await TestUtils.waitForCondition(
    () => box.getNotificationWithValue(NOTIFICATION_ID),
    "Offer appears on a store page"
  );
  is(notification.getAttribute("crx-id"), CRX_ID, "Offer is for that item");

  ChromeWebStore.onLocationChange(browser, Services.io.newURI(STORE_URL));
  is(
    box.allNotifications.filter(n => n.getAttribute("value") == NOTIFICATION_ID)
      .length,
    1,
    "Revisiting does not add a second offer"
  );

  ChromeWebStore.onLocationChange(
    browser,
    Services.io.newURI("https://example.com/")
  );
  ok(
    !box.getNotificationWithValue(NOTIFICATION_ID),
    "Offer goes away when leaving the store"
  );
});

add_task(async function test_install() {
  await SpecialPowers.pushPrefEnv({
    set: [["xpinstall.signatures.required", false]],
  });
  const crx = await makeCrx();
  const download = sinon.stub(ChromeWebStore, "downloadCrx").resolves(crx);
  const installed = new Promise(resolve => {
    const listener = {
      onInstallEnded(install, addon) {
        AddonManager.removeInstallListener(listener);
        resolve(addon);
      },
    };
    AddonManager.addInstallListener(listener);
  });

  const installedNotification = BrowserTestUtils.waitForEvent(
    PanelUI.notificationPanel,
    "popupshown"
  );

  try {
    const prompt = promisePermissionPrompt();
    const result = ChromeWebStore.install(gBrowser.selectedBrowser, CRX_ID);
    const panel = await prompt;
    ok(true, "Firefox's permission prompt is shown");
    panel.button.click();
    await result;

    const addon = await installed;
    is(addon.id, `${CRX_ID}@chromewebstore`, "Installed with a Firefox id");
    await TestUtils.waitForCondition(() => addon.isActive, "Add-on running");
    ok(download.calledOnceWith(CRX_ID), "Downloaded from the store once");

    await installedNotification;
    const doorhanger = document.getElementById(
      "appMenu-addon-installed-notification"
    );
    ok(BrowserTestUtils.isVisible(doorhanger), "Install is confirmed");
    const hidden = BrowserTestUtils.waitForEvent(
      PanelUI.notificationPanel,
      "popuphidden"
    );
    doorhanger.button.click();
    await hidden;

    await closePopupNotifications();
    await addon.uninstall();
  } finally {
    download.restore();
    await closePopupNotifications();
  }
});

add_task(async function test_invalid_id_is_rejected() {
  await Assert.rejects(
    ChromeWebStore.install(gBrowser.selectedBrowser, "../../etc"),
    /Invalid extension id/
  );
});
