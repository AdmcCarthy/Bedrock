# Bedrock: working rules

@../../shared/idiom/CORE.md

Voice and dataset terms follow Idiom (`CORE.md`, `DATASETS.md`; private repo, normally linked at `../../shared/idiom`). The import is harmless when the file is absent. Public repo: never copy anything from Idiom's `personal/` or `working/` folders here.

A static public gallery of display layers from the private pipelines `geology-map-processing` and `source-to-sink`, on Relief terrain. Owner: Adam McCarthy.

- `scripts/publish.py` is the only way layers get here. It copies allow-listed regions whose every map has an open licence for display, rewrites the viewers' data paths, and writes `site/manifest.json`. Edit the allow-lists there, never copy files by hand.
- A map whose licence is unverified or restricts display is not published, whatever its value. `DATA-LICENCE.md` lists what is shown and what is held back; keep it in step with Idiom `DATASETS.md`.
- The viewers (`site/geology.js`, `site/s2s.js`) are copies of the private previews; change them there and republish.
- Relief's hillshade and bands are copied reduced with Relief's attribution; nothing else of Relief's data is copied.
- Screenshots in `site/shots/` are WebP made by `scripts/shots.py` with headless Chrome; look at them before publishing.
- The site is static: `python -m http.server` in `site/` shows it; GitHub Pages serves `site/` from `.github/workflows/pages.yml`.
