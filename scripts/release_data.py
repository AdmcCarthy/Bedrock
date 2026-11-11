"""Upload the big layer files that publish.py set aside to a GitHub release, so Pages stays small.

publish.py moves every layer file over BIG_BYTES to dist/<DATA_TAG>/ and writes the release URL into the region's
layers.json. This script creates the release (or reuses it) and uploads the files with --clobber, so a republish
replaces them in place and the URLs never change. The viewers fetch release assets directly (GitHub serves them with
open CORS).

Usage: uv run --project ../geology-map-processing python scripts/release_data.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from publish import DATA_TAG, DIST  # noqa: E402

REPO = "AdmcCarthy/Bedrock"


def main() -> None:
    files = sorted(p for p in DIST.glob("*") if p.is_file())
    if not files:
        raise SystemExit(f"nothing in {DIST}; run publish.py first")
    have = subprocess.run(["gh", "release", "view", DATA_TAG, "--repo", REPO], capture_output=True, text=True).returncode == 0
    if not have:
        subprocess.run(["gh", "release", "create", DATA_TAG, "--repo", REPO, "--title", f"Layer files {DATA_TAG}",
                        "--notes", "Display layers too large for Pages: detail-level bedrock TopoJSON and slope-flow lines. Written by scripts/publish.py; terms in DATA-LICENCE.md."], check=True)
    total = sum(p.stat().st_size for p in files) / 1e6
    subprocess.run(["gh", "release", "upload", DATA_TAG, *map(str, files), "--repo", REPO, "--clobber"], check=True)
    print(f"{len(files)} files, {total:.0f} MB, on release {DATA_TAG}")


if __name__ == "__main__":
    main()
