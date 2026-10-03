/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Runs the WireGuard provider against a fake wireproxy that only listens on
// the SOCKS port from its configuration.

const { FreeVPNWireGuard, canConnect } = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPNWireGuard.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const PRIVATE_KEY = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const PUBLIC_KEY = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";
const CONFIG = `[Interface]
PrivateKey = ${PRIVATE_KEY}
Address = 10.2.0.2/32
[Peer]
PublicKey = ${PUBLIC_KEY}
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.5:51820
`;

const FAKE_WIREPROXY = `#!/bin/sh
exec python3 -c '
import os, re, socket, sys
config = open(sys.argv[2]).read()
if os.environ.get("FAKE_WIREPROXY_MODE") == "crash":
    print("fake wireproxy: handshake failed", flush=True)
    sys.exit(3)
assert "WGConfig = " in config
port = int(re.search(r"BindAddress = 127\\.0\\.0\\.1:(\\d+)", config).group(1))
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("127.0.0.1", port))
server.listen(5)
print("listening", port, flush=True)
while True:
    conn, _ = server.accept()
    conn.close()
    if os.environ.get("FAKE_WIREPROXY_MODE") == "die-after-connect":
        print("fake wireproxy: tunnel lost", flush=True)
        sys.exit(1)
' "$@"
`;

add_setup(async function () {
  do_get_profile();
  const binary = PathUtils.join(PathUtils.profileDir, "fake-wireproxy");
  await IOUtils.writeUTF8(binary, FAKE_WIREPROXY);
  await IOUtils.setPermissions(binary, 0o755);
  Services.prefs.setStringPref("browser.freevpn.wireguard.binaryPath", binary);
  registerCleanupFunction(() => {
    Services.env.set("FAKE_WIREPROXY_MODE", "");
    Services.prefs.clearUserPref("browser.freevpn.wireguard.binaryPath");
  });
});

add_task(async function test_not_configured() {
  await FreeVPNWireGuard.removeConfig();
  await Assert.rejects(
    new FreeVPNWireGuard().start(),
    e => e.code == "wireguard-not-configured"
  );
});

add_task(async function test_import() {
  const endpoint = await FreeVPNWireGuard.importConfig(CONFIG);
  Assert.equal(endpoint, "203.0.113.5:51820");
  Assert.equal(
    Services.prefs.getStringPref("browser.freevpn.wireguard.endpoint"),
    endpoint
  );
  Assert.ok(await FreeVPNWireGuard.hasConfig());
  const { permissions } = await IOUtils.stat(FreeVPNWireGuard.configPath);
  Assert.equal(permissions & 0o077, 0, "Only the user can read the key");
});

add_task(async function test_start_and_stop() {
  Services.env.set("FAKE_WIREPROXY_MODE", "ok");
  const proxy = new FreeVPNWireGuard();
  const port = await proxy.start();
  Assert.greater(port, 0, "Got a SOCKS port");
  Assert.ok(proxy.running);
  Assert.ok(await canConnect(port), "SOCKS port accepts connections");

  await proxy.stop();
  Assert.ok(!proxy.running);
  await TestUtils.waitForCondition(
    async () => !(await canConnect(port)),
    "Port is closed after stopping"
  );
});

add_task(async function test_crash_reports_output() {
  Services.env.set("FAKE_WIREPROXY_MODE", "crash");
  await Assert.rejects(
    new FreeVPNWireGuard().start(),
    e =>
      e.code == "wireguard-exited" &&
      e.detail.includes("fake wireproxy: handshake failed")
  );
});

add_task(async function test_unexpected_exit_is_reported() {
  Services.env.set("FAKE_WIREPROXY_MODE", "die-after-connect");
  let exitDetail = null;
  const proxy = new FreeVPNWireGuard({
    onExit: detail => (exitDetail = detail),
  });
  await proxy.start();
  await TestUtils.waitForCondition(() => exitDetail !== null, "onExit called");
  Assert.ok(exitDetail.includes("fake wireproxy: tunnel lost"), exitDetail);
  Assert.ok(!proxy.running);
});
