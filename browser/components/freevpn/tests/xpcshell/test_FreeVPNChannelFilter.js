/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  FreeVPNChannelFilter,
  FreeVPNMode,
  hostMatchesDomains,
  isLocalHost,
  makeProxyInfo,
  parseDomainList,
} = ChromeUtils.importESModule(
  "moz-src:///browser/components/freevpn/FreeVPNChannelFilter.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

function makeChannel(url, privateBrowsingId = 0) {
  const channel = NetUtil.newChannel({
    uri: url,
    loadUsingSystemPrincipal: true,
  });
  if (privateBrowsingId) {
    channel.loadInfo.originAttributes = { privateBrowsingId };
  }
  return channel;
}

function applyFilter(filter, channel) {
  return new Promise(resolve => {
    filter.applyFilter(channel, null, {
      onProxyFilterResult: resolve,
    });
  });
}

add_task(function test_isLocalHost() {
  Assert.ok(isLocalHost("localhost"));
  Assert.ok(isLocalHost("app.localhost"));
  Assert.ok(isLocalHost("127.0.0.1"));
  Assert.ok(isLocalHost("127.1.2.3"));
  Assert.ok(isLocalHost("[::1]"));
  Assert.ok(!isLocalHost("example.com"));
  Assert.ok(!isLocalHost("10.0.0.1"));
});

add_task(function test_makeProxyInfo_socks() {
  const info = makeProxyInfo(
    { type: "socks", host: "127.0.0.1", port: 9050 },
    "key"
  );
  Assert.equal(info.type, "socks");
  Assert.equal(info.host, "127.0.0.1");
  Assert.equal(info.port, 9050);
  Assert.equal(info.username, "freevpn-key");
  Assert.ok(info.flags & Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST);
});

add_task(function test_makeProxyInfo_http() {
  const info = makeProxyInfo(
    { type: "http", host: "proxy.example", port: 8080 },
    "key"
  );
  Assert.equal(info.type, "http");
  Assert.equal(info.port, 8080);
});

add_task(function test_shouldProxy() {
  const filter = new FreeVPNChannelFilter();
  Assert.ok(filter.shouldProxy(makeChannel("https://example.com/")));
  Assert.ok(!filter.shouldProxy(makeChannel("http://localhost:8000/")));
  Assert.ok(!filter.shouldProxy(makeChannel("http://127.0.0.1/")));

  filter.mode = FreeVPNMode.PRIVATE;
  Assert.ok(!filter.shouldProxy(makeChannel("https://example.com/")));
  Assert.ok(filter.shouldProxy(makeChannel("https://example.com/", 1)));

  filter.alwaysTunneledHosts.add("check.example");
  Assert.ok(filter.shouldProxy(makeChannel("https://check.example/api")));

  filter.mode = "bogus";
  Assert.equal(filter.mode, FreeVPNMode.ALL);
});

add_task(async function test_hold_then_proxy() {
  const filter = new FreeVPNChannelFilter();
  filter.hold();
  const pending = applyFilter(filter, makeChannel("https://example.com/"));
  filter.setProxy({ type: "socks", host: "127.0.0.1", port: 9150 });
  const info = await pending;
  Assert.equal(info.port, 9150, "Held channel is released into the tunnel");

  const before = (await applyFilter(filter, makeChannel("https://a.test/")))
    .username;
  filter.newIdentity();
  const after = (await applyFilter(filter, makeChannel("https://a.test/")))
    .username;
  Assert.notEqual(before, after, "New identity changes the SOCKS isolation");
});

add_task(async function test_kill_switch() {
  const filter = new FreeVPNChannelFilter();
  filter.hold();
  const pending = applyFilter(filter, makeChannel("https://example.com/"));
  filter.block();
  const held = await pending;
  Assert.equal(held.port, 9, "Held channel is sent to the dead proxy");

  const info = await applyFilter(filter, makeChannel("https://example.org/"));
  Assert.equal(info.port, 9, "New channels are blocked too");

  const local = await applyFilter(filter, makeChannel("http://localhost/"));
  Assert.equal(local, null, "Local traffic is never blocked");
});

add_task(function test_parseDomainList() {
  Assert.deepEqual(
    [
      ...parseDomainList(
        " Meet.Google.com, *.zoom.us\nbad value,localhost,.x.org"
      ),
    ],
    ["meet.google.com", "zoom.us", "x.org"]
  );
  Assert.equal(parseDomainList("").size, 0);
});

add_task(function test_hostMatchesDomains() {
  const domains = new Set(["zoom.us"]);
  Assert.ok(hostMatchesDomains("zoom.us", domains));
  Assert.ok(hostMatchesDomains("us02web.ZOOM.us", domains));
  Assert.ok(!hostMatchesDomains("notzoom.us", domains));
  Assert.ok(!hostMatchesDomains("zoom.us.evil.com", domains));
});

add_task(function test_split_tunneling() {
  const filter = new FreeVPNChannelFilter();
  filter.bypassDomains = new Set(["meet.google.com"]);
  Assert.ok(!filter.shouldProxy(makeChannel("https://meet.google.com/abc")));
  Assert.ok(filter.shouldProxy(makeChannel("https://google.com/")));
  Assert.ok(filter.shouldProxy(makeChannel("https://example.com/")));
});
