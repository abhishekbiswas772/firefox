/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { buildTorrc, parseTorLogLine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPNTorLauncher.sys.mjs"
);

add_task(function test_buildTorrc_minimal() {
  const torrc = buildTorrc({ dataDir: "/tmp/tor data" });
  Assert.ok(torrc.includes("SocksPort 127.0.0.1:auto IsolateSOCKSAuth"));
  Assert.ok(torrc.includes('DataDirectory "/tmp/tor data"'));
  Assert.ok(!torrc.includes("ExitNodes"));
  Assert.ok(!torrc.includes("UseBridges"));
});

add_task(function test_buildTorrc_exitCountry() {
  const torrc = buildTorrc({ dataDir: "/d", exitCountry: "DE" });
  Assert.ok(torrc.includes("ExitNodes {de}"));
  Assert.ok(torrc.includes("StrictNodes 1"));

  const invalid = buildTorrc({ dataDir: "/d", exitCountry: "de}\nBad 1" });
  Assert.ok(!invalid.includes("ExitNodes"), "Invalid codes are ignored");
});

add_task(function test_buildTorrc_windowsPaths() {
  const torrc = buildTorrc({ dataDir: "C:\\Users\\a b\\tor" });
  Assert.ok(torrc.includes('DataDirectory "C:\\\\Users\\\\a b\\\\tor"'));
});

add_task(function test_buildTorrc_bridges() {
  const torrc = buildTorrc({
    dataDir: "/d",
    bridges: ["", "obfs4 1.2.3.4:443 FINGERPRINT cert=x iat-mode=0", "  "],
    lyrebirdPath: "/opt/lyrebird",
  });
  Assert.ok(torrc.includes("UseBridges 1"));
  Assert.ok(torrc.includes('exec "/opt/lyrebird"'));
  Assert.ok(
    torrc.includes("Bridge obfs4 1.2.3.4:443 FINGERPRINT cert=x iat-mode=0")
  );
  Assert.equal(torrc.match(/^Bridge /gm).length, 1);
});

add_task(function test_parseTorLogLine() {
  Assert.deepEqual(
    parseTorLogLine(
      "Oct 02 12:00:00.000 [notice] Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors"
    ),
    { bootstrap: 45, tag: "requesting_descriptors" }
  );
  Assert.deepEqual(
    parseTorLogLine(
      "Oct 02 12:00:00.000 [notice] Opened Socks listener connection (ready) on 127.0.0.1:41235"
    ),
    { socksPort: 41235 }
  );
  Assert.deepEqual(
    parseTorLogLine("Oct 02 12:00:00.000 [warn] Could not bind to 127.0.0.1"),
    { problem: "Could not bind to 127.0.0.1" }
  );
  Assert.deepEqual(parseTorLogLine("random text"), {});
});
