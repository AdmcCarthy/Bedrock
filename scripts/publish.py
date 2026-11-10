"""Publish the display layers and viewers from the private pipelines into site/ as a static gallery.

Only regions whose every source is open for public display are copied (the allow-lists below); each copied region's
licence lines are written into site/manifest.json and DATA-LICENCE.md is the human record. Relief's hillshade and
land band for each frame are copied reduced, with Relief's attribution. The viewers are the preview pages of
geology-map-processing and source-to-sink with their data paths rewritten to this site.

Usage: uv run --project ../geology-map-processing python scripts/publish.py
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
P = ROOT.parent
GEO = P / "geology-map-processing"
S2S = P / "source-to-sink"
RELIEF = P / "Relief"
SITE = ROOT / "site"

# regions whose maps all carry an open licence: NLOD (NGU), SGU open geodata, GTK open licence, OGL (BGS, GSNI), CC BY 4.0 (GSI, GeoSphere)
GEOLOGY_REGIONS = ["norway", "uk_ireland", "north_sea", "fennoscandia", "alps_east", "ne_europe_open"]
OPEN_MAPS = {"no_ngu_n1350_units", "se_sgu_1m_bedrock", "fi_gtk_1m_rocktypes", "uk_bgs_625k_bedrock", "ni_gsni_250k_bedrock",
             "ie_gsi_500k_bedrock", "at_geosphere_500k"}
# catchment layers are HydroSHEDS geometry with derived statistics; the statistics cite every map used
S2S_REGIONS = ["north_sea", "norwegian_sea", "ne_europe"]
RELIEF_FRAMES = ["ne_europe", "north_sea", "norwegian_sea"]


def copy_tree(src: Path, dst: Path, allow=None) -> list[str]:
    dst.mkdir(parents=True, exist_ok=True)
    out = []
    for f in src.iterdir():
        if f.is_file() and (allow is None or allow(f)):
            shutil.copy2(f, dst / f.name)
            out.append(f.name)
    return out


def main() -> None:
    SITE.mkdir(exist_ok=True)
    manifest = {"geology": {}, "s2s": {}, "relief": {}, "excluded": {}}

    # Relief frames: hillshade (full regional resolution) and bands
    for fr in RELIEF_FRAMES:
        d = SITE / "relief" / fr
        d.mkdir(parents=True, exist_ok=True)
        man = json.loads((RELIEF / "data" / "out" / fr / "manifest.json").read_text(encoding="utf-8"))
        Image.open(RELIEF / "data" / "out" / fr / "regional_hillshade.png").convert("L").save(d / "regional_hillshade.png", optimize=True)
        shutil.copy2(RELIEF / "data" / "out" / fr / "regional.geojson", d / "regional.geojson")
        Image.open(RELIEF / "data" / "out" / fr / "overview_hillshade.png").convert("L").save(d / "overview_hillshade.png", optimize=True)
        shutil.copy2(RELIEF / "data" / "out" / fr / "overview.geojson", d / "overview.geojson")
        manifest["relief"][fr] = {"crs": man["crs"], "extent": man["extent"], "attribution": "Relief (github.com/AdmcCarthy/Relief): Copernicus DEM GLO-90 (ESA), EMODnet Bathymetry; Kartverket and MAREANO on the Norwegian Sea frame"}

    # geology regions
    for r in GEOLOGY_REGIONS:
        src = GEO / "data" / "display" / r
        if not (src / "layers.json").exists():
            manifest["excluded"][f"geology/{r}"] = "not built"
            continue
        doc = json.loads((src / "layers.json").read_text(encoding="utf-8"))
        maps = {m["map_id"] for lv in doc["levels"].values() for m in lv["maps"] if m.get("file")}
        bad = sorted(maps - OPEN_MAPS)
        if bad:
            manifest["excluded"][f"geology/{r}"] = f"maps without an open licence for display: {bad}"
            continue
        dst = SITE / "data" / "geology" / r
        copy_tree(src, dst, allow=lambda f: f.suffix in (".topojson", ".json"))
        # the relief references point at this site
        if doc.get("relief"):
            fr = doc["relief"]["region"]
            doc["relief"]["hillshade"] = {k: f"relief/{fr}/{k}_hillshade.png" for k in doc["relief"]["hillshade"] if (SITE / "relief" / fr / f"{k}_hillshade.png").exists()}
            doc["relief"]["bands"] = {k: f"relief/{fr}/{k}.geojson" for k in doc["relief"]["bands"] if (SITE / "relief" / fr / f"{k}.geojson").exists()}
            (dst / "layers.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
        lic = {}
        for lv in doc["levels"].values():
            for m in lv["maps"]:
                if m.get("file"):
                    lic[m["map_id"]] = {"title": m["title"], "licence": m["licence"], "attribution": m["attribution"]}
        manifest["geology"][r] = {"name": doc["name"], "levels": list(doc["levels"]), "maps": lic, "relief": bool(doc.get("relief"))}

    # source to sink regions
    for r in S2S_REGIONS:
        src = S2S / "data" / "derived" / r
        if not (src / "layers.json").exists():
            manifest["excluded"][f"s2s/{r}"] = "not built"
            continue
        doc = json.loads((src / "layers.json").read_text(encoding="utf-8"))
        dst = SITE / "data" / "s2s" / r
        copy_tree(src, dst, allow=lambda f: f.suffix in (".topojson", ".geojson", ".json", ".csv"))
        fr = doc["relief"]["region"]
        doc["relief"]["hillshade"] = f"relief/{fr}/regional_hillshade.png"
        doc["relief"]["bands"] = f"relief/{fr}/regional.geojson"
        (dst / "layers.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
        manifest["s2s"][r] = {"name": doc["name"], "attribution": doc["attribution"], "geology_maps": doc["geology_maps"], "counts": doc["counts"]}

    # viewers: the private previews with their paths rewritten
    shutil.copy2(GEO / "preview" / "palettes.json", SITE / "palettes.json")
    shutil.copy2(GEO / "preview" / "style.css", SITE / "style.css")
    css = (SITE / "style.css").read_text(encoding="utf-8")
    extra = (S2S / "preview" / "style.css").read_text(encoding="utf-8").split("/* source-to-sink additions */")[-1]
    (SITE / "style.css").write_text(css + "\n/* source-to-sink additions */" + extra, encoding="utf-8")
    g = (GEO / "preview" / "map.js").read_text(encoding="utf-8")
    g = g.replace('const base = `../data/display/${region}/`;', 'const base = `data/geology/${region}/`;').replace('"../../" + doc.relief.hillshade[lv]', 'doc.relief.hillshade[lv]').replace('"../../" + doc.relief.bands[lv]', 'doc.relief.bands[lv]')
    (SITE / "geology.js").write_text(g, encoding="utf-8")
    h = (GEO / "preview" / "map.html").read_text(encoding="utf-8").replace('src="map.js"', 'src="geology.js"').replace('<a href="index.html">Geology map layers</a>', '<a href="index.html">Bedrock</a>')
    (SITE / "geology.html").write_text(h, encoding="utf-8")
    s = (S2S / "preview" / "map.js").read_text(encoding="utf-8")
    s = s.replace('const base = `../data/derived/${region}/`;', 'const base = `data/s2s/${region}/`;').replace('fetch("../../" + doc.relief.bands)', 'fetch(doc.relief.bands)').replace('hill.src = "../../" + doc.relief.hillshade;', 'hill.src = doc.relief.hillshade;')
    (SITE / "s2s.js").write_text(s, encoding="utf-8")
    h2 = (S2S / "preview" / "map.html").read_text(encoding="utf-8").replace('src="map.js"', 'src="s2s.js"').replace('<a href="index.html">Source to sink</a>', '<a href="index.html">Bedrock</a>')
    (SITE / "s2s.html").write_text(h2, encoding="utf-8")
    (SITE / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
    size = sum(f.stat().st_size for f in SITE.rglob("*") if f.is_file()) / 1e6
    print(f"site: {len(manifest['geology'])} geology regions, {len(manifest['s2s'])} source-to-sink regions, {size:.0f} MB; excluded: {manifest['excluded']}")


if __name__ == "__main__":
    main()
