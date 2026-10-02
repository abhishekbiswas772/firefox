/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { buildTorrc, parsePtConfig, parseTorLogLine } =
  ChromeUtils.importESModule(
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
    transportPlugins: [
      "ClientTransportPlugin obfs4 exec pluggable_transports/lyrebird",
    ],
  });
  Assert.ok(torrc.includes("UseBridges 1"));
  Assert.ok(
    torrc.includes(
      "ClientTransportPlugin obfs4 exec pluggable_transports/lyrebird"
    )
  );
  Assert.ok(
    torrc.includes("Bridge obfs4 1.2.3.4:443 FINGERPRINT cert=x iat-mode=0")
  );
  Assert.equal(torrc.match(/^Bridge /gm).length, 1);
});

add_task(function test_buildTorrc_noBridgesNoTransports() {
  const torrc = buildTorrc({
    dataDir: "/d",
    transportPlugins: ["ClientTransportPlugin obfs4 exec lyrebird"],
  });
  Assert.ok(!torrc.includes("ClientTransportPlugin"));
  Assert.ok(!torrc.includes("UseBridges"));
});

add_task(function test_buildTorrc_noInjection() {
  const torrc = buildTorrc({
    dataDir: "/d",
    bridges: ["obfs4 1.2.3.4:443 X\nSocksPort 0.0.0.0:9050"],
  });
  Assert.ok(!/^SocksPort 0\.0\.0\.0/m.test(torrc));
});

add_task(function test_buildTorrc_batterySaver() {
  Assert.ok(
    buildTorrc({ dataDir: "/d", batterySaver: true }).includes(
      "ReducedConnectionPadding 1"
    )
  );
  Assert.ok(
    !buildTorrc({ dataDir: "/d" }).includes("ReducedConnectionPadding")
  );
});

add_task(function test_parsePtConfig() {
  const config = {
    recommendedDefault: "obfs4",
    pluggableTransports: {
      lyrebird:
        "ClientTransportPlugin meek_lite,obfs4,webtunnel exec ${pt_path}lyrebird",
      snowflake:
        "ClientTransportPlugin snowflake exec ${pt_path}snowflake-client",
    },
    bridges: {
      obfs4: ["obfs4 192.0.2.1:443 A cert=b iat-mode=0"],
      snowflake: ["snowflake 192.0.2.3:80 B fingerprint=C url=https://x/"],
      bogus: "not an array",
    },
  };
  const { transportPlugins, bridges } = parsePtConfig(
    config,
    "pluggable_transports/"
  );
  Assert.deepEqual(transportPlugins, [
    "ClientTransportPlugin meek_lite,obfs4,webtunnel exec pluggable_transports/lyrebird",
    "ClientTransportPlugin snowflake exec pluggable_transports/snowflake-client",
  ]);
  Assert.deepEqual(Object.keys(bridges).sort(), ["obfs4", "snowflake"]);
  Assert.deepEqual(parsePtConfig(null, "x/"), {
    transportPlugins: [],
    bridges: {},
  });
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
