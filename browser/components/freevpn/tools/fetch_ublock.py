# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Bundle uBlock Origin so the built-in ad blocker works on first run.

Downloads the Mozilla-signed uBlock Origin XPI from its GitHub releases and
puts it in <browser dir>/distribution/extensions, which Firefox installs into
new profiles. Firefox checks Mozilla's signature when installing it.

    python3 browser/components/freevpn/tools/fetch_ublock.py \
        --dest obj-x86_64-pc-linux-gnu/dist/bin
"""

import argparse
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

ADDON_ID = "uBlock0@raymondhill.net"
RELEASES = "https://api.github.com/repos/gorhill/uBlock/releases"
ASSET_RE = re.compile(r"^uBlock0_[\d.]+\.firefox\.signed\.xpi$")


def fetch(url, accept=None):
    print(f"Downloading {url}", file=sys.stderr)
    request = urllib.request.Request(url)
    if accept:
        request.add_header("Accept", accept)
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def find_asset(release):
    for asset in release.get("assets", []):
        if ASSET_RE.match(asset["name"]):
            return asset["browser_download_url"]
    raise SystemExit(f"No signed Firefox XPI in release {release.get('tag_name')}")


def check_xpi(data):
    with zipfile.ZipFile(io.BytesIO(data)) as xpi:
        names = set(xpi.namelist())
        if "META-INF/mozilla.rsa" not in names and "META-INF/cose.sig" not in names:
            raise SystemExit("XPI is not signed by Mozilla")
        manifest = json.loads(xpi.read("manifest.json"))
    gecko = manifest.get("browser_specific_settings") or manifest.get("applications")
    addon_id = (gecko or {}).get("gecko", {}).get("id")
    if addon_id != ADDON_ID:
        raise SystemExit(f"Unexpected add-on id {addon_id!r}")
    return manifest["version"]


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dest",
        required=True,
        help="Directory containing the firefox binary (e.g. obj-*/dist/bin)",
    )
    parser.add_argument("--tag", help="uBlock Origin release tag (default: latest)")
    args = parser.parse_args()

    url = f"{RELEASES}/tags/{args.tag}" if args.tag else f"{RELEASES}/latest"
    release = json.loads(fetch(url, "application/vnd.github+json"))
    data = fetch(find_asset(release))
    version = check_xpi(data)

    target = os.path.join(args.dest, "distribution", "extensions")
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, f"{ADDON_ID}.xpi"), "wb") as f:
        f.write(data)
    print(f"uBlock Origin {version} bundled in {target}")


if __name__ == "__main__":
    main()
