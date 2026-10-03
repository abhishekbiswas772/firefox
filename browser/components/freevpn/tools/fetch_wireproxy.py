# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Bundle wireproxy so Free VPN's WireGuard provider works out of the box.

wireproxy (ISC licence) is a userspace WireGuard client that exposes a
SOCKS5 proxy, so it needs no admin rights. This downloads the official
release from GitHub, checks GitHub's SHA-256 digest when the API provides
one, and puts the binary in <browser dir>/freevpn-wireguard:

    python3 browser/components/freevpn/tools/fetch_wireproxy.py \
        --platform linux-x86_64 --dest obj-x86_64-pc-linux-gnu/dist/bin
"""

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import urllib.request
import zipfile

RELEASES = "https://api.github.com/repos/windtf/wireproxy/releases"
PLATFORMS = {"linux-x86_64": ("linux", "amd64"), "windows-x86_64": ("windows", "amd64")}
TARGET_DIR = "freevpn-wireguard"


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


def find_asset(release, platform):
    system, arch = PLATFORMS[platform]
    pattern = re.compile(
        rf"^wireproxy[_-]{system}[_-]{arch}\.(tar\.gz|zip)$", re.IGNORECASE
    )
    for asset in release.get("assets", []):
        if pattern.match(asset["name"]):
            return asset
    names = ", ".join(a["name"] for a in release.get("assets", []))
    raise SystemExit(
        f"No {platform} asset in wireproxy release {release.get('tag_name')}: {names}"
    )


def extract_binary(data, name):
    """Return the bytes of the file called `name` inside a tar.gz or zip."""
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for info in archive.infolist():
                if os.path.basename(info.filename) == name:
                    return archive.read(info)
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive.getmembers():
                if member.isfile() and os.path.basename(member.name) == name:
                    return archive.extractfile(member).read()
    raise SystemExit(f"{name} not found in the archive")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    parser.add_argument(
        "--dest",
        required=True,
        help="Directory containing the firefox binary (e.g. obj-*/dist/bin)",
    )
    parser.add_argument("--tag", help="wireproxy release tag (default: latest)")
    args = parser.parse_args()

    url = f"{RELEASES}/tags/{args.tag}" if args.tag else f"{RELEASES}/latest"
    release = json.loads(fetch(url, "application/vnd.github+json"))
    asset = find_asset(release, args.platform)
    data = fetch(asset["browser_download_url"])

    digest = asset.get("digest") or ""
    if digest.startswith("sha256:"):
        if hashlib.sha256(data).hexdigest() != digest.split(":", 1)[1].lower():
            raise SystemExit(f"SHA-256 mismatch for {asset['name']}")
    else:
        print("GitHub did not publish a digest; skipping check", file=sys.stderr)

    exe = "wireproxy.exe" if args.platform.startswith("windows") else "wireproxy"
    binary = extract_binary(data, exe)
    target = os.path.join(args.dest, TARGET_DIR)
    os.makedirs(target, exist_ok=True)
    path = os.path.join(target, exe)
    with open(path, "wb") as f:
        f.write(binary)
    os.chmod(path, 0o755)
    print(f"wireproxy {release.get('tag_name')} installed to {path}")


if __name__ == "__main__":
    main()
