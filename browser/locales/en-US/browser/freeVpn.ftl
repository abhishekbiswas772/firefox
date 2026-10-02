# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Free VPN toolbar button and panel. The free VPN sends browser traffic
## through the Tor network (or another proxy the user chooses).

freevpn-title = Free VPN

freevpn-button =
    .label = Free VPN
    .tooltiptext = Free VPN is off. Click to turn on.
freevpn-button-on =
    .label = Free VPN
    .tooltiptext = Free VPN is on. Click to turn off.
freevpn-button-connecting =
    .label = Free VPN
    .tooltiptext = Free VPN is connecting… Click to cancel.
freevpn-button-error =
    .label = Free VPN
    .tooltiptext = Free VPN could not connect. Click to turn off.
freevpn-dropmarker =
    .label = Free VPN settings
    .tooltiptext = Free VPN settings

freevpn-toggle =
    .label = Use free VPN

freevpn-status-disabled = Free VPN is unavailable
freevpn-status-off = VPN is off
freevpn-status-connecting = Connecting…
freevpn-status-on = VPN is on
freevpn-status-error = Could not connect

# Variables:
#   $percent (Number) - How far the Tor connection has progressed, 0 to 100.
freevpn-detail-connecting = Building a private connection ({ $percent }%)
# Variables:
#   $percent (Number) - How far the Tor connection has progressed, 0 to 100.
#   $bridge (String) - Bridge type, e.g. "snowflake". Not translated.
freevpn-detail-connecting-bridge = Getting past network blocking with a { $bridge } bridge ({ $percent }%)
freevpn-detail-on = Your browsing is hidden from your network.
# Variables:
#   $ip (String) - The public IP address websites now see.
freevpn-detail-on-ip = Websites see the address { $ip }
freevpn-detail-error = { -brand-short-name } is using your normal connection.
freevpn-detail-error-blocked = Browsing is blocked so your real address is not exposed. Turn the VPN off to use your normal connection.
freevpn-detail-off-tor = Uses the free, open source Tor network. No account needed.
freevpn-detail-off-tor-system = Uses the Tor service already running on this computer.
freevpn-detail-off-custom = Uses the proxy server you set up below.

## Error messages. Variables:
##   $detail (String) - Technical details from Tor or the network, in English.

freevpn-error-tor-not-found =
    .message = Tor was not found. Install Tor from torproject.org or set browser.freevpn.tor.binaryPath.
freevpn-error-tor-timeout =
    .message = Connecting to Tor took too long. Your network may block Tor; try adding bridges.
freevpn-error-tor-exited =
    .message = Tor stopped unexpectedly: { $detail }
freevpn-error-proxy-unreachable =
    .message = Could not reach the proxy server. Check that it is running. ({ $detail })
freevpn-error-bridges-unavailable =
    .message = No built-in “{ $detail }” bridges are available. Install the Tor Expert Bundle or choose another bridge type.
freevpn-error-custom-not-configured =
    .message = Enter the host and port of your proxy server.
freevpn-error-unknown =
    .message = Something went wrong: { $detail }

##

# Split tunneling for one site.
# Variables:
#   $site (String) - The site, e.g. "example.com".
freevpn-site-bypass =
    .label = Don’t use VPN on { $site }
    .description = Use this for video calls and sites that block VPNs.

freevpn-new-identity =
    .label = New identity
freevpn-check-ip =
    .label = Check my connection

freevpn-provider =
    .label = Connect through
freevpn-provider-tor =
    .label = Tor network (built in)
freevpn-provider-tor-system =
    .label = Tor already running on this computer
freevpn-provider-custom =
    .label = Custom proxy server

freevpn-location =
    .label = Location
freevpn-location-auto =
    .label = Automatic (fastest)

freevpn-bridges =
    .label = Bridges (for networks that block Tor)
freevpn-bridges-auto =
    .label = Automatic
freevpn-bridges-none =
    .label = Off
freevpn-bridges-snowflake =
    .label = Snowflake
freevpn-bridges-obfs4 =
    .label = obfs4
freevpn-bridges-meek =
    .label = meek (cloud)
freevpn-bridges-custom =
    .label = My own bridges (browser.freevpn.tor.bridges)

freevpn-custom-type =
    .label = Proxy type
freevpn-custom-type-socks =
    .label = SOCKS5
freevpn-custom-type-http =
    .label = HTTP
freevpn-custom-type-https =
    .label = HTTPS
freevpn-custom-host =
    .label = Host
freevpn-custom-port =
    .label = Port

freevpn-private-only =
    .label = Only use the VPN in private windows
freevpn-kill-switch =
    .label = Block browsing if the VPN disconnects
freevpn-battery-saver =
    .label = Battery saver
    .description = Lets Tor sleep when you are not browsing and sends less padding.
freevpn-auto-connect =
    .label = Reconnect when { -brand-short-name } starts

freevpn-footer = Tor is free and open source software run by volunteers. Some websites block or slow down Tor connections.

## Built-in ad blocker toolbar button.

adblock-button-on =
    .label = Ad blocker
    .tooltiptext = Ads and trackers are blocked. Click to allow ads.
adblock-button-off =
    .label = Ad blocker
    .tooltiptext = Ads are allowed. Click to block ads and trackers.
adblock-button-busy =
    .label = Ad blocker
    .tooltiptext = Turning on the ad blocker…
adblock-button-error =
    .label = Ad blocker
    .tooltiptext = The ad blocker could not be installed. Check your connection and click to try again.
