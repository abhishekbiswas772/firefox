/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  BACKGROUND_SHIM,
  SHIM_PATH,
  convertChromeManifest,
  convertToXpi,
  crxToZip,
  extensionIdFromUrl,
  findImportedScripts,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/ChromeWebStore.sys.mjs"
);
const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "1",
  "1"
);

const CRX_ID = "abcdefghijklmnopabcdefghijklmnop";

// A typical Manifest V3 Chrome extension.
const CHROME_MANIFEST = {
  manifest_version: 3,
  name: "Sample Chrome extension",
  version: "1.2.3",
  key: "MIIBIjANBgkq",
  update_url: "https://clients2.google.com/service/update2/crx",
  minimum_chrome_version: "120",
  incognito: "split",
  background: { service_worker: "sw.js" },
  side_panel: { default_path: "panel.html" },
  permissions: ["storage", "offscreen", "sidePanel", "tabs"],
  action: { default_title: "Sample" },
};

const FILES = {
  "manifest.json": JSON.stringify(CHROME_MANIFEST),
  "sw.js": 'importScripts("lib/util.js", "./vendor.js");\nself.ok = true;\n',
  "lib/util.js": "self.util = true;\n",
  "vendor.js": "self.vendor = true;\n",
  "panel.html": "<!doctype html><title>panel</title>",
  "_metadata/verified_contents.json": "[]",
};

function stringStream(text) {
  const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
    Ci.nsIStringInputStream
  );
  stream.setUTF8Data(text);
  return stream;
}

async function makeZip(files) {
  const path = PathUtils.join(
    PathUtils.tempDir,
    `cws-test-${Services.uuid.generateUUID().toString().slice(1, 9)}.zip`
  );
  const writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  writer.open(new FileUtils.File(path), 0x04 | 0x08 | 0x20);
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
  const bytes = await IOUtils.read(path);
  await IOUtils.remove(path);
  return bytes;
}

function makeCrx(zip, version = 3) {
  const header = new Uint8Array([9, 8, 7, 6, 5]);
  const headerLength = version == 3 ? 12 : 16;
  const out = new Uint8Array(headerLength + header.length + zip.length);
  out.set([0x43, 0x72, 0x32, 0x34], 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, version, true);
  if (version == 3) {
    view.setUint32(8, header.length, true);
  } else {
    // Public key length, then a zero-length signature.
    view.setUint32(8, header.length, true);
    view.setUint32(12, 0, true);
  }
  out.set(header, headerLength);
  out.set(zip, headerLength + header.length);
  return out;
}

function readZip(path) {
  const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader
  );
  reader.open(new FileUtils.File(path));
  const names = [];
  const entries = reader.findEntries(null);
  while (entries.hasMore()) {
    names.push(entries.getNext());
  }
  const read = name => {
    const stream = reader.getInputStream(name);
    return NetUtil.readInputStreamToString(stream, stream.available(), {
      charset: "UTF-8",
    });
  };
  return { reader, names, read };
}

add_task(function test_extensionIdFromUrl() {
  Assert.equal(
    extensionIdFromUrl(
      `https://chromewebstore.google.com/detail/some-name/${CRX_ID}`
    ),
    CRX_ID
  );
  Assert.equal(
    extensionIdFromUrl(
      `https://chromewebstore.google.com/detail/${CRX_ID}?hl=en`
    ),
    CRX_ID
  );
  Assert.equal(
    extensionIdFromUrl(
      `https://chrome.google.com/webstore/detail/name/${CRX_ID}`
    ),
    CRX_ID
  );
  Assert.equal(
    extensionIdFromUrl(
      Services.io.newURI(`https://chromewebstore.google.com/detail/x/${CRX_ID}`)
    ),
    CRX_ID,
    "Accepts nsIURI"
  );
  for (const url of [
    `http://chromewebstore.google.com/detail/x/${CRX_ID}`,
    `https://evil.example/detail/x/${CRX_ID}`,
    "https://chromewebstore.google.com/category/extensions",
    "https://chromewebstore.google.com/detail/x/NOTANID",
    "not a url",
    null,
  ]) {
    Assert.equal(extensionIdFromUrl(url), null, `No id in ${url}`);
  }
});

add_task(async function test_crxToZip() {
  const zip = await makeZip({ "a.txt": "a" });
  Assert.deepEqual(crxToZip(makeCrx(zip, 3)), zip, "CRX3 payload");
  Assert.deepEqual(crxToZip(makeCrx(zip, 2)), zip, "CRX2 payload");
  Assert.deepEqual(crxToZip(zip), zip, "A plain ZIP passes through");
  Assert.throws(() => crxToZip(new Uint8Array(20)), /Not a Chrome extension/);
  const corrupt = makeCrx(zip, 3);
  new DataView(corrupt.buffer).setUint32(8, 999999, true);
  Assert.throws(() => crxToZip(corrupt), /Corrupt/);
  const future = makeCrx(zip, 3);
  new DataView(future.buffer).setUint32(4, 9, true);
  Assert.throws(() => crxToZip(future), /Unsupported CRX version/);
});

add_task(function test_findImportedScripts() {
  Assert.deepEqual(findImportedScripts(FILES["sw.js"], "sw.js"), [
    "lib/util.js",
    "vendor.js",
  ]);
  Assert.deepEqual(
    findImportedScripts(
      "importScripts('../a.js'); importScripts('b.js')",
      "js/sw.js"
    ),
    ["a.js", "js/b.js"],
    "Resolved relative to the worker"
  );
  Assert.deepEqual(
    findImportedScripts("importScripts('https://cdn.example/x.js')", "sw.js"),
    [],
    "Remote scripts are ignored"
  );
});

add_task(function test_convertChromeManifest() {
  const { manifest, removedPermissions, usesShim } = convertChromeManifest(
    CHROME_MANIFEST,
    CRX_ID,
    name => FILES[name] ?? null
  );
  Assert.ok(usesShim);
  Assert.equal(
    manifest.browser_specific_settings.gecko.id,
    `${CRX_ID}@chromewebstore`
  );
  Assert.deepEqual(manifest.background, {
    scripts: [SHIM_PATH, "lib/util.js", "vendor.js", "sw.js"],
  });
  for (const key of [
    "key",
    "update_url",
    "minimum_chrome_version",
    "side_panel",
  ]) {
    Assert.ok(!(key in manifest), `${key} removed`);
  }
  Assert.equal(manifest.incognito, "spanning");
  Assert.deepEqual(manifest.sidebar_action, { default_panel: "panel.html" });
  Assert.deepEqual(manifest.permissions, ["storage", "tabs"]);
  Assert.deepEqual(removedPermissions, ["offscreen", "sidePanel"]);
  Assert.equal(
    CHROME_MANIFEST.background.service_worker,
    "sw.js",
    "Input untouched"
  );

  const module = convertChromeManifest(
    {
      ...CHROME_MANIFEST,
      background: { service_worker: "m.js", type: "module" },
    },
    CRX_ID
  ).manifest;
  Assert.deepEqual(module.background, {
    scripts: [SHIM_PATH, "m.js"],
    type: "module",
  });

  const both = convertChromeManifest(
    {
      ...CHROME_MANIFEST,
      background: { service_worker: "sw.js", scripts: ["bg.js"] },
      browser_specific_settings: { gecko: { id: "own@example.com" } },
    },
    CRX_ID
  );
  Assert.deepEqual(both.manifest.background, { scripts: ["bg.js"] });
  Assert.equal(
    both.manifest.browser_specific_settings.gecko.id,
    "own@example.com"
  );
  Assert.ok(!both.usesShim);
});

add_task(async function test_convert_and_install() {
  Services.prefs.setBoolPref("xpinstall.signatures.required", false);
  Services.prefs.setBoolPref("extensions.manifestV3.enabled", true);
  await AddonTestUtils.promiseStartupManager();

  const zip = crxToZip(makeCrx(await makeZip(FILES)));
  const xpiPath = PathUtils.join(PathUtils.tempDir, `${CRX_ID}.xpi`);
  await convertToXpi(zip, CRX_ID, xpiPath);

  const { reader, names, read } = readZip(xpiPath);
  try {
    Assert.ok(names.includes(SHIM_PATH), "Shim added");
    Assert.equal(read(SHIM_PATH), BACKGROUND_SHIM);
    Assert.ok(names.includes("lib/util.js") && names.includes("vendor.js"));
    Assert.ok(
      !names.some(name => name.startsWith("_metadata/")),
      "Chrome signature metadata dropped"
    );
    const manifest = JSON.parse(read("manifest.json"));
    Assert.equal(
      manifest.browser_specific_settings.gecko.id,
      `${CRX_ID}@chromewebstore`
    );
  } finally {
    reader.close();
  }

  // Running the extension needs a full browser; browser_chrome_web_store.js
  // covers that. Loading the install validates the manifest against
  // Firefox's WebExtension schemas.
  const install = await AddonManager.getInstallForFile(
    new FileUtils.File(xpiPath)
  );
  Assert.equal(install.error, 0, "Firefox accepts the converted extension");
  Assert.equal(install.state, AddonManager.STATE_DOWNLOADED);
  Assert.equal(install.addon.id, `${CRX_ID}@chromewebstore`);
  Assert.equal(install.addon.type, "extension");
  Assert.ok(
    !install.addon.appDisabled,
    "The extension is compatible and allowed unsigned"
  );
  install.cancel();
  await IOUtils.remove(xpiPath);
});
