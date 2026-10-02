/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Runs the launcher and the service against a fake tor (a shell script) to
// check process handling: bootstrap, stalls, crashes, bridges and shutdown.

const { FreeVPNTorLauncher } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs"
);
const { FreeVPN, FreeVPNStates } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPN.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const FAKE_PORT = 45678;
const FAKE_TOR = `#!/bin/sh
torrc="$2"
cp "$torrc" "$torrc.seen"
case "$FAKE_TOR_MODE" in
  exit)
    echo "Oct 02 00:00:00.000 [err] Fake tor failed on purpose"
    exit 1
    ;;
  stall)
    echo "Oct 02 00:00:00.000 [notice] Bootstrapped 5% (conn): Connecting"
    exec sleep 600
    ;;
  bridges-only)
    if ! grep -q '^UseBridges 1' "$torrc"; then
      echo "Oct 02 00:00:00.000 [notice] Bootstrapped 5% (conn): Connecting"
      exec sleep 600
    fi
    ;;
esac
echo "Oct 02 00:00:00.000 [notice] Opened Socks listener connection (ready) on 127.0.0.1:${FAKE_PORT}"
for p in 10 50 100; do
  echo "Oct 02 00:00:00.000 [notice] Bootstrapped $p% (done): Done"
done
exec sleep 600
`;

const PT_CONFIG = {
  pluggableTransports: {
    lyrebird:
      "ClientTransportPlugin meek_lite,obfs4,webtunnel exec ${pt_path}lyrebird",
    snowflake:
      "ClientTransportPlugin snowflake exec ${pt_path}snowflake-client",
  },
  bridges: {
    snowflake: [
      "snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72",
    ],
    obfs4: ["obfs4 192.0.2.1:443 A0B1C2 cert=abc iat-mode=0"],
  },
};

let bundleDir;
let torPath;

function torrcSeen() {
  return IOUtils.readUTF8(
    PathUtils.join(PathUtils.profileDir, "freevpn", "tor", "torrc.seen")
  );
}

add_setup(async function () {
  do_get_profile();
  bundleDir = PathUtils.join(PathUtils.profileDir, "fakebundle");
  const torDir = PathUtils.join(bundleDir, "tor");
  const ptDir = PathUtils.join(torDir, "pluggable_transports");
  await IOUtils.makeDirectory(ptDir, { createAncestors: true });
  await IOUtils.makeDirectory(PathUtils.join(bundleDir, "data"));
  await IOUtils.writeUTF8(PathUtils.join(bundleDir, "data", "geoip"), "");
  await IOUtils.writeJSON(PathUtils.join(ptDir, "pt_config.json"), PT_CONFIG);
  torPath = PathUtils.join(torDir, "tor");
  await IOUtils.writeUTF8(torPath, FAKE_TOR);
  await IOUtils.setPermissions(torPath, 0o755);

  Services.prefs.setStringPref("browser.freevpn.tor.binaryPath", torPath);
  Services.prefs.setIntPref("browser.freevpn.tor.stallTimeoutSeconds", 1);
  registerCleanupFunction(() => {
    Services.env.set("FAKE_TOR_MODE", "");
    Services.prefs.clearUserPref("browser.freevpn.tor.binaryPath");
    Services.prefs.clearUserPref("browser.freevpn.tor.stallTimeoutSeconds");
  });
});

add_task(async function test_start_and_stop() {
  Services.env.set("FAKE_TOR_MODE", "ok");
  const progress = [];
  const launcher = new FreeVPNTorLauncher({
    onProgress: percent => progress.push(percent),
  });
  const port = await launcher.start({ exitCountry: "nl", batterySaver: true });
  Assert.equal(port, FAKE_PORT, "Reports the SOCKS port tor opened");
  Assert.ok(launcher.running, "Tor is running");
  Assert.deepEqual(progress, [10, 50, 100], "Reports bootstrap progress");

  const torrc = await torrcSeen();
  Assert.ok(torrc.includes("SocksPort 127.0.0.1:auto IsolateSOCKSAuth"));
  Assert.ok(
    torrc.includes(`__OwningControllerProcess ${Services.appinfo.processID}`),
    "Tor exits with the browser"
  );
  Assert.ok(torrc.includes("ExitNodes {nl}"), "Exit country is applied");
  Assert.ok(torrc.includes("ReducedConnectionPadding 1"), "Battery saver");
  Assert.ok(torrc.includes("GeoIPFile"), "Bundled GeoIP data is used");
  Assert.ok(!torrc.includes("UseBridges"), "No bridges unless asked");

  await launcher.stop();
  Assert.ok(!launcher.running, "Tor is stopped");
});

add_task(async function test_stall_times_out() {
  Services.env.set("FAKE_TOR_MODE", "stall");
  const launcher = new FreeVPNTorLauncher();
  await Assert.rejects(
    launcher.start(),
    e => e.code == "tor-timeout",
    "A stalled bootstrap fails"
  );
  Assert.ok(!launcher.running, "The stalled tor is stopped");
});

add_task(async function test_crash_is_reported() {
  Services.env.set("FAKE_TOR_MODE", "exit");
  const launcher = new FreeVPNTorLauncher();
  await Assert.rejects(
    launcher.start(),
    e => e.code == "tor-exited" && e.detail == "Fake tor failed on purpose",
    "Tor's error message is passed on"
  );
});

add_task(async function test_builtin_bridges() {
  Services.env.set("FAKE_TOR_MODE", "ok");
  Assert.deepEqual(
    (await FreeVPNTorLauncher.availableBridgeTypes()).sort(),
    ["obfs4", "snowflake"],
    "Built-in bridge types come from pt_config.json"
  );

  const launcher = new FreeVPNTorLauncher();
  await launcher.start({ bridgeType: "obfs4" });
  const torrc = await torrcSeen();
  Assert.ok(torrc.includes("UseBridges 1"));
  Assert.ok(torrc.includes(`Bridge ${PT_CONFIG.bridges.obfs4[0]}`));
  Assert.ok(
    torrc.includes(
      "ClientTransportPlugin meek_lite,obfs4,webtunnel exec pluggable_transports/lyrebird"
    ),
    "Transports are relative to tor's directory"
  );
  Assert.ok(!torrc.includes("Bridge snowflake"), "Only the chosen type");
  await launcher.stop();

  await Assert.rejects(
    new FreeVPNTorLauncher().start({ bridgeType: "meek" }),
    e => e.code == "bridges-unavailable",
    "Missing bridge types are reported"
  );
});

add_task(async function test_service_falls_back_to_bridges() {
  Services.env.set("FAKE_TOR_MODE", "bridges-only");
  Services.prefs.setStringPref("browser.freevpn.provider", "tor");
  Services.prefs.setStringPref("browser.freevpn.tor.bridgeType", "auto");
  Services.prefs.setStringPref(
    "browser.freevpn.tor.lastWorkingBridgeType",
    "none"
  );
  registerCleanupFunction(() => {
    FreeVPN.disconnect();
    for (const pref of [
      "browser.freevpn.provider",
      "browser.freevpn.tor.bridgeType",
      "browser.freevpn.tor.lastWorkingBridgeType",
    ]) {
      Services.prefs.clearUserPref(pref);
    }
  });

  FreeVPN.connect();
  await TestUtils.waitForCondition(
    () => FreeVPN.state == FreeVPNStates.ON,
    "Connects once a bridge works"
  );
  Assert.equal(FreeVPN.bridgeInUse, "snowflake", "Snowflake is tried first");
  Assert.equal(
    Services.prefs.getStringPref("browser.freevpn.tor.lastWorkingBridgeType"),
    "snowflake",
    "The working bridge type is remembered"
  );

  FreeVPN.disconnect();
  Assert.equal(FreeVPN.state, FreeVPNStates.OFF);

  // The next connection starts with the bridge that worked, without trying
  // (and waiting for) a direct connection first.
  const attempted = new Set();
  const record = () => {
    // Progress events come from a running tor attempt.
    if (FreeVPN.state == FreeVPNStates.CONNECTING && FreeVPN.progress > 0) {
      attempted.add(FreeVPN.bridgeInUse);
    }
  };
  FreeVPN.addEventListener("FreeVPN:StateChanged", record);
  FreeVPN.connect();
  await TestUtils.waitForCondition(() => FreeVPN.state == FreeVPNStates.ON);
  FreeVPN.removeEventListener("FreeVPN:StateChanged", record);
  Assert.equal(FreeVPN.bridgeInUse, "snowflake");
  Assert.ok(!attempted.has("none"), "No direct attempt on reconnect");
  FreeVPN.disconnect();
});
