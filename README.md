# Bedrock

A public gallery, in Relief's manner, of open geological maps read into one language and of the catchments that erode them, drawn with D3 at several levels of detail with every display type the pipelines offer. Live at https://admccarthy.github.io/Bedrock/ once Pages has deployed.

| Page | What | Views |
| :--- | :--- | :--- |
| `geology.html?r=<region>` | A bedrock region at overview, regional and detail levels | age (chart, vintage or paper palette), lithology, age with rock as hatch, rock with age as tone, fjord ramp; plain or vintage frame; hillshade strength on Relief frames |
| `s2s.html?r=<region>` | A source-to-sink region: catchments, rivers, outlets on Relief terrain | bedrock group, sand quality, yield, sand supply, shield and carbonate shares, size classes with a fold; rivers, flow lines, slope flow; strong or subtle ink |

Regions: Norway, Britain and Ireland, the North Sea, Fennoscandia, Austria and an open-licence North-east Europe for bedrock; the North Sea, the Norwegian Sea and North-east Europe for source to sink.

The layers are published from the author's private pipelines (`europe-gis-data`, `geology-map-processing`, `source-to-sink`) by `scripts/publish.py`, which copies only regions whose every map carries an open licence for display and writes the sources into `site/manifest.json`. `DATA-LICENCE.md` is the record of terms. The site is static; GitHub Pages serves `site/` as it is.

Add `&theme=light` or `&theme=dark` to a page address to force a theme; the other options are buttons on the page.
