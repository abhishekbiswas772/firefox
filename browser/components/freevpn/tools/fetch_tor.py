# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

"""Download the Tor Expert Bundle and unpack it where Free VPN looks for it.

Free VPN runs tor from <browser dir>/freevpn-tor/tor/tor[.exe]. Run this
after building (into obj-*/dist/bin) or after packaging (into the unpacked
firefox/ directory):

    python3 browser/components/freevpn/tools/fetch_tor.py \
        --platform linux-x86_64 --dest obj-x86_64-pc-linux-gnu/dist/bin
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import urllib.request

DOWNLOADS_JSON = (
    "https://aus1.torproject.org/torbrowser/update_3/release/downloads.json"
)
DIST = "https://dist.torproject.org/torbrowser/{version}/"
BUNDLE = "tor-expert-bundle-{platform}-{version}.tar.gz"
SUMS = "sha256sums-signed-build.txt"
PLATFORMS = ("linux-x86_64", "linux-i686", "windows-x86_64", "windows-i686")
TARGET_DIR = "freevpn-tor"


def fetch(url):
    print(f"Downloading {url}", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def latest_version():
    return json.loads(fetch(DOWNLOADS_JSON))["version"]


def expected_sha256(sums, filename):
    for line in sums.decode().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == filename:
            return parts[0].lower()
    raise SystemExit(f"{filename} is not listed in {SUMS}")


def safe_members(archive):
    for member in archive.getmembers():
        name = os.path.normpath(member.name)
        if name.startswith(("..", "/")) or os.path.isabs(name):
            raise SystemExit(f"Refusing unsafe path in archive: {member.name}")
        if name.split(os.sep)[0] == "debug":
            continue
        if member.issym() or member.islnk():
            target = os.path.normpath(
                os.path.join(os.path.dirname(name), member.linkname)
            )
            if target.startswith(".."):
                raise SystemExit(f"Refusing unsafe link in archive: {member.name}")
        yield member


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--platform", required=True, choices=PLATFORMS)
    parser.add_argument(
        "--dest",
        required=True,
        help="Directory containing the firefox binary (e.g. obj-*/dist/bin)",
    )
    parser.add_argument("--version", help="Tor Browser release (default: latest)")
    args = parser.parse_args()

    version = args.version or latest_version()
    base = DIST.format(version=version)
    filename = BUNDLE.format(platform=args.platform, version=version)

    sums = fetch(base + SUMS)
    data = fetch(base + filename)
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256(sums, filename):
        raise SystemExit(f"SHA-256 mismatch for {filename}")

    target = os.path.join(args.dest, TARGET_DIR)
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        extra = {"filter": "tar"} if hasattr(tarfile, "tar_filter") else {}
        archive.extractall(target, members=safe_members(archive), **extra)

    exe = "tor.exe" if args.platform.startswith("windows") else "tor"
    tor = os.path.join(target, "tor", exe)
    if not os.path.isfile(tor):
        raise SystemExit(f"{tor} missing after extraction")
    if not exe.endswith(".exe"):
        os.chmod(tor, 0o755)
    print(f"Tor {version} installed to {target}")


if __name__ == "__main__":
    main()
