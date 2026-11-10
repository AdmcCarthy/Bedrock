/* One region of geology layers drawn on Canvas.
   Data: ../data/display/<region>/layers.json (contract geology_layers: 1), the TopoJSON files it lists, palettes.json.
   A region exported in a Relief frame CRS (doc.relief) is drawn with an identity transform over Relief's hillshade
   (served from the sibling repo, so serve the repos' parent folder); a lon/lat region uses a conic projection.
   Views: age | lithology | age+hatch | tone (lithology hue, age as lightness on a linear ramp) | fjord (age alone on
   SubScout's fjord ramp) | terrain (Relief frames only: Relief's height and depth classes, bedrock hidden).
   Palettes: ics | vintage | paper. Frames: plain | vintage. Shade: 0 (off) to 1.5.
   Under everything on a Relief frame, Relief's base map (regional_base_{light,dark}.png: linear bathymetry, stepped
   climate-tinted land; Relief/docs/base-maps.md); the depth key follows Relief's manifest. Bands are coloured here only
   for a frame without a base. */

const params = new URLSearchParams(location.search);
const region = params.get("r") || "norway";
const base = `data/geology/${region}/`;
const [doc, pal] = await Promise.all([fetch(base + "layers.json").then(r => r.json()), fetch("palettes.json").then(r => r.json())]);
const stage = document.getElementById("stage"), canvas = document.getElementById("map"), ctx = canvas.getContext("2d");
const tip = document.getElementById("tip");
document.getElementById("title").textContent = doc.name; document.title = doc.name;

const theme = params.get("theme");
if (theme) document.documentElement.dataset.theme = theme;
const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
let mode = params.get("mode") || "age";
let palette = params.get("palette") || "ics";
let frame = params.get("frame") || "plain";
let levelName = params.get("level") || null;
let shade = params.has("shade") ? +params.get("shade") : (doc.relief ? 0.9 : 0);
const projected = !!doc.relief;            // metres in the Relief frame CRS
const cache = new Map(), hillCache = new Map(), bandCache = new Map();

/* geometry helpers */
const bboxFeature = (() => {
  if (projected) { const [x0, y0, x1, y1] = doc.relief.extent; return { type: "Feature", geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] } }; }
  const [w, s, e, n] = doc.bbox, pts = [];
  for (let i = 0; i <= 40; i++) pts.push([w + (e - w) * i / 40, n]);
  for (let i = 40; i >= 0; i--) pts.push([e, s + (n - s) * i / 40]);
  for (let i = 40; i >= 0; i--) pts.push([w + (e - w) * i / 40, s]);
  for (let i = 0; i <= 40; i++) pts.push([w, s + (n - s) * i / 40]);
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] } };
})();
function rewind(geometry) {
  if (projected) return geometry;
  const fix = rings => rings.map((ring, i) => { const a = d3.geoArea({ type: "Polygon", coordinates: [ring] }); return (i === 0 ? a > 2 * Math.PI : a < 2 * Math.PI) ? ring.slice().reverse() : ring; });
  if (geometry.type === "Polygon") geometry.coordinates = fix(geometry.coordinates);
  else if (geometry.type === "MultiPolygon") geometry.coordinates = geometry.coordinates.map(fix);
  return geometry;
}
function makeProjection(width, height, pad) {
  if (projected) return d3.geoIdentity().reflectY(true).fitExtent([[pad, pad], [width - pad, height - pad]], bboxFeature);
  const p = doc.projection || {};
  return d3.geoConicEqualArea().parallels(p.parallels || [45, 60]).rotate(p.rotate || [0, 0]).fitExtent([[pad, pad], [width - pad, height - pad]], bboxFeature);
}
function chooseLevel(proj) {
  let mPerPx;
  if (projected) { const [x0, y0, x1] = doc.relief.extent; const a = proj([x0, y0]), b = proj([x1, y0]); mPerPx = (x1 - x0) / Math.hypot(b[0] - a[0], b[1] - a[1]); }
  else { const [w, s, e, n] = doc.bbox, cx = (w + e) / 2, cy = (s + n) / 2; const a = proj([cx, cy]), b = proj([cx + 0.01, cy]); mPerPx = (0.01 * 111320 * Math.cos(cy * Math.PI / 180)) / Math.hypot(b[0] - a[0], b[1] - a[1]); }
  const levels = Object.entries(doc.levels).map(([k, v]) => [k, v.metres_per_px]).sort((x, y) => y[1] - x[1]);
  let pick = levels[levels.length - 1][0];
  for (const [k, mpp] of levels) if (mpp <= mPerPx * 1.2) { pick = k; break; }
  return pick;
}
async function loadLevel(name) {
  if (cache.has(name)) return cache.get(name);
  const out = [];
  for (const m of doc.levels[name].maps) {
    if (!m.file) continue;
    const topo = await (await fetch(base + m.file)).json();
    const fc = topojson.feature(topo, topo.objects[m.map_id]);
    const mesh = topojson.mesh(topo, topo.objects[m.map_id], (a, b) => a !== b);
    for (const f of fc.features) { rewind(f.geometry); f.bbox = projected ? d3.geoPath().bounds(f) : d3.geoBounds(f); }
    out.push({ map: m, features: fc.features, mesh });
  }
  cache.set(name, out); return out;
}
// Relief's hillshade PNG is light (flat ground sits near 180 of 255), and soft-light is neutral at mid grey, so drawn as it
// comes it barely shows. Flat ground is moved to mid grey and the slopes stretched before the shade is composited.
function toneHill(img, flat = 180, gain = 2.5) {
  const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
  const x = c.getContext("2d"); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) { const v = Math.max(0, Math.min(255, 128 + (p[i] - flat) * gain)); p[i] = p[i + 1] = p[i + 2] = v; }
  x.putImageData(d, 0, 0); return c;
}
async function loadRelief(level) {
  if (!projected) return [null, null];
  const lv = doc.relief.hillshade[level] ? level : Object.keys(doc.relief.hillshade).slice(-1)[0];
  if (!hillCache.has(lv)) {
    const img = new Image(); img.src = doc.relief.hillshade[lv];
    await new Promise(res => { img.onload = res; img.onerror = res; });
    hillCache.set(lv, img.width ? toneHill(img) : null);
    const b = await fetch(doc.relief.bands[lv]).then(r => r.ok ? r.json() : null).catch(() => null);
    bandCache.set(lv, b);
    // Relief's base map (Relief/docs/base-maps.md): linear bathymetry on the frame's depth scale, stepped land tints by climate
    // zone, rendered once by Relief; its manifest names the depth scale for the key
    const dir = (doc.relief.hillshade[lv]).replace(/\/[^/]*$/, "");
    const rm = await fetch(dir + "/manifest.json").then(r => r.ok ? r.json() : null).catch(() => null);
    const bases = {};
    if (rm && rm.base) for (const th of ["light", "dark"]) { const im = new Image(); im.src = dir + "/" + rm.base.regional[th]; await new Promise(res => { im.onload = res; im.onerror = res; }); if (im.width) bases[th] = im; }
    baseCache.set(lv, { rm, bases });
  }
  return [hillCache.get(lv), bandCache.get(lv), baseCache.get(lv)];
}
const baseCache = new Map();

/* colour */
const noAge = () => dark ? "#6b7280" : "#cfd3d8";
const ageColour = p => p.ics_display ? (pal.age[palette][p.ics_display] || noAge()) : noAge();
const lithoColour = p => (palette === "ics" ? pal.lithology.house : pal.lithology.vintage)[p.litho_class] || pal.lithology.house.unknown;
const midAge = p => p.age_old_ma != null && p.age_young_ma != null ? (p.age_old_ma + p.age_young_ma) / 2 : null;
const ageT = p => { const a = midAge(p); return a == null ? null : Math.min(1, Math.max(0, (Math.log10(Math.max(a, 1)) - 0.5) / 3.0)); }; // 3 Ma -> 0, 3.2 Ga -> 1
// SubScout's fjord hue (OKLCH anchor L 0.50, C 0.085, h 204.6); a linear ramp in OKLab lightness from paper-light to deep
function fjord(t) { const L = 0.94 - 0.60 * t, C = 0.03 + 0.07 * Math.sin(Math.PI * t), h = 204.6 * Math.PI / 180; return oklabHex(L, C * Math.cos(h), C * Math.sin(h)); }
function toneColour(p) {
  const t = ageT(p); const base = lithoColour(p);
  if (t == null) return base;
  const lab = d3.lab(base); lab.l = 88 - 58 * t; return lab.formatHex(); // same lightness scale for every class: lighter young, darker old
}
function oklabHex(L, a, b) {
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_];
  const srgb = lin.map(c => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; });
  return "#" + srgb.map(c => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}
function fillOf(p) {
  if (p.litho_class === "ice_water") return dark ? "#3b4350" : (frame === "vintage" ? "#f7f3ea" : "#f4f6f8");
  if (mode === "lithology") return lithoColour(p);
  if (mode === "tone") return toneColour(p);
  if (mode === "fjord") { const t = ageT(p); return t == null ? noAge() : fjord(t); }
  return ageColour(p);
}
const alphaFill = (hex, a) => { const c = d3.color(hex); if (!c) return hex; c.opacity = a; return c.formatRgb(); };

/* Relief's Detuned house style, copied from Relief/preview/palette.js: the shelf depth ramp (0 to 1,300 m, linear) and the
   temperate height ramp at half saturation. Relief's stacked bands are coloured at each band's midpoint, so the sea reads on
   Relief's own depth scale under every view, the terrain view shows the land on its height scale, and the key shows both. */
const RELIEF = {
  seaStops: [0, 20, 50, 100, 200, 500, 1000], seaMax: 1300,
  sea: { light: ["#e8f0f2", "#cfe1e6", "#aacdd8", "#7eb0c5", "#5891ae", "#3a6d94", "#264b73", "#162b50"], dark: ["#3a8aa2", "#2f7690", "#25647d", "#1c526b", "#144157", "#0e3045", "#092336", "#06172a"] },
  oceanStops: [0, 200, 1000, 2000, 3000, 4000, 5000, 6000, 7000], oceanMax: 7000,
  ocean: { light: ["#e2f4f9", "#bfe2ed", "#83bddc", "#5c9acd", "#4579ba", "#355a9f", "#2a3e80", "#1e2763", "#131546"], dark: ["#71b7c8", "#56a5bd", "#2c83aa", "#1d679c", "#154b8a", "#113375", "#101e5c", "#0a0b42", "#040027"] },
  landStops: [0, 50, 150, 300, 600, 1000, 1500, 2000], landMax: 2000,
  landRaw: { light: ["#d6e8b8", "#c6dea0", "#bad38f", "#cbcf92", "#d9c897", "#ccb8a0", "#d8d0c6", "#efece8"], dark: ["#46572f", "#4c5d33", "#536237", "#5d633b", "#665f42", "#655d50", "#85807a", "#aaa6a1"] },
};
function tune(h, sat, mix) { const c = d3.rgb(h), y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, t = mix > 0 ? 255 : 0, m = Math.abs(mix); const f = v => { const g = y + (v - y) * sat; return g + (t - g) * m; }; return d3.rgb(f(c.r), f(c.g), f(c.b)).formatHex(); }
function reliefColour(kind, metres) {
  const th = dark ? "dark" : "light";
  const cols = kind === "sea" ? RELIEF.sea[th] : kind === "ocean" ? RELIEF.ocean[th] : RELIEF.landRaw[th].map(h => tune(h, 0.5, dark ? -0.08 : 0.08));
  const br = kind === "sea" ? RELIEF.seaStops : kind === "ocean" ? RELIEF.oceanStops : RELIEF.landStops, max = kind === "sea" ? RELIEF.seaMax : kind === "ocean" ? RELIEF.oceanMax : RELIEF.landMax;
  const stops = br.map((b, i) => [b / max, cols[i]]); if (cols.length > br.length) stops.push([1, cols.at(-1)]);
  let t = Math.min(1, Math.max(0, metres / max)), k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
  const [t0, c0] = stops[k], [t1, c1] = stops[k + 1]; return d3.interpolateRgb(c0, c1)(Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1))));
}
// stacked bands, drawn from the outermost in: each band is "everything deeper (or higher) than its level", coloured at its midpoint
function bandLevels(bands, kind) { return [...new Set(bands.features.filter(f => f.properties.kind === kind).map(f => Math.abs(f.properties.level)))].sort((a, b) => a - b); }
function bandMid(levels, i) { return i + 1 < levels.length ? (levels[i] + levels[i + 1]) / 2 : levels[i] + (levels[i] - (levels[i - 1] ?? 0)) / 2; }
function drawBands(bands, kind, alpha) {
  const levels = bandLevels(bands, kind);
  for (const [i, lv] of levels.entries()) {
    const feats = bands.features.filter(f => f.properties.kind === kind && Math.abs(f.properties.level) === lv);
    ctx.beginPath(); for (const f of feats) path(f); ctx.fillStyle = alphaFill(reliefColour(kind, bandMid(levels, i)), alpha); ctx.fill();
  }
  return levels;
}
/* Legend pieces: a stepped strip with the band breaks written under it, and a linear bar with ticks at named values, so a
   log or a linear scale can be read at the values that matter rather than at its two ends. */
const fmtN = v => v.toLocaleString("en-GB");
function stepStrip(title, kind, levels) {
  const cells = levels.map((lv, i) => `<span style="background:${reliefColour(kind, bandMid(levels, i))}" title="${fmtN(lv)}${i + 1 < levels.length ? "–" + fmtN(levels[i + 1]) : "+"} m"></span>`).join("");
  const labs = levels.map((lv, i) => `<span>${fmtN(lv)}${i + 1 === levels.length ? "+" : ""}</span>`).join("");
  return `<div class="k">${title}</div><div class="steps">${cells}</div><div class="labs">${labs}</div>`;
}
function tickBar(title, rampOf, ticks) {
  const stops = d3.range(0, 1.001, 1 / 24).map(t => `<span style="flex:1;background:${rampOf(t)}"></span>`).join("");
  const tk = ticks.map(([t, l]) => `<span style="left:${(100 * t).toFixed(1)}%">${l}</span>`).join("");
  return `<div class="k">${title}</div><div class="bar">${stops}</div><div class="ticks">${tk}</div>`;
}
let reliefLevels = { sea: null, land: null, rm: null };
// the depth key as Relief's manifest describes it (a linear bar with the manifest's ticks), else the stepped bands drawn here
function depthKey() {
  if (reliefLevels.rm) {
    const ds = reliefLevels.rm.base.depth_scale, kind = ds.kind === "ocean" ? "ocean" : "sea", max = ds.max_m;
    const ticks = ds.ticks_m.filter(v => v / max < 0.9).map(v => [v / max, fmtN(v)]).concat([[1, fmtN(max) + "+"]]);
    return tickBar(`Sea floor, depth in m (Relief, linear, ${ds.kind} scale)`, t => reliefColour(kind, t * max), ticks);
  }
  return reliefLevels.sea ? stepStrip("Sea floor, depth in m (Relief, shelf scale)", "sea", reliefLevels.sea) : "";
}

/* hatches */
const hatchCache = new Map();
function hatch(name) {
  if (name === "none" || !name) return null;
  const key = name + (dark ? "d" : "l");
  if (hatchCache.has(key)) return hatchCache.get(key);
  const dpr = devicePixelRatio || 1, s = 8, c = document.createElement("canvas"); c.width = c.height = s * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.strokeStyle = g.fillStyle = dark ? "rgba(255,255,255,.45)" : "rgba(30,30,30,.42)"; g.lineWidth = 0.6;
  const dense = name.endsWith("-dense"), basename = name.replace("-dense", "").replace("-dashed", "");
  g.beginPath();
  if (basename === "dots") { g.arc(2, 2, 0.6, 0, 7); g.arc(6, 6, 0.6, 0, 7); g.fill(); }
  else if (basename === "stipple") { g.arc(3, 5, 0.45, 0, 7); g.fill(); }
  else if (basename === "bricks") { g.moveTo(0, 2); g.lineTo(8, 2); g.moveTo(0, 6); g.lineTo(8, 6); g.moveTo(2, 2); g.lineTo(2, 6); g.moveTo(6, 6); g.lineTo(6, 10); if (name.endsWith("-dashed")) g.setLineDash([1.5, 1.5]); g.stroke(); }
  else if (basename === "crosses") { g.moveTo(1, 1); g.lineTo(4, 4); g.moveTo(4, 1); g.lineTo(1, 4); g.stroke(); }
  else if (basename === "dashes") { g.moveTo(0, 4); g.lineTo(5, 4); g.stroke(); }
  else if (basename === "vees") { g.moveTo(1, 2); g.lineTo(3, 5); g.lineTo(5, 2); if (dense) { g.moveTo(5, 5); g.lineTo(7, 8); g.lineTo(9, 5); } g.stroke(); }
  else if (basename === "plus") { g.moveTo(4, 1); g.lineTo(4, 7); g.moveTo(1, 4); g.lineTo(7, 4); if (dense) { g.moveTo(0, 0); g.lineTo(2, 0); g.moveTo(0, 8); g.lineTo(2, 8); } g.stroke(); }
  else if (basename === "waves") { g.moveTo(0, 4); g.quadraticCurveTo(2, 1, 4, 4); g.quadraticCurveTo(6, 7, 8, 4); g.stroke(); }
  else if (basename === "diagonal") { g.moveTo(0, 8); g.lineTo(8, 0); if (dense) { g.moveTo(-4, 8); g.lineTo(4, 0); g.moveTo(4, 8); g.lineTo(12, 0); } g.stroke(); }
  else if (basename === "grid") { g.moveTo(0, 4); g.lineTo(8, 4); g.moveTo(4, 0); g.lineTo(4, 8); g.stroke(); }
  const pat = ctx.createPattern(c, "repeat"); pat.setTransform(new DOMMatrix().scale(1 / dpr));
  hatchCache.set(key, pat); return pat;
}

let layers = [], proj, path, width, height;
async function render() {
  const dpr = devicePixelRatio || 1;
  width = stage.clientWidth; height = stage.clientHeight;
  canvas.width = width * dpr; canvas.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vintage = frame === "vintage", pad = vintage ? 52 : 12;
  proj = makeProjection(width, height, pad);
  const chosen = levelName || chooseLevel(proj);
  layers = await loadLevel(chosen); path = d3.geoPath(proj, ctx); markLevel(chosen);
  const [hill, bands, rbase] = await loadRelief(chosen);

  ctx.fillStyle = vintage ? (dark ? "#2a2722" : pal.paper) : getComputedStyle(document.body).getPropertyValue("--sea").trim();
  ctx.fillRect(0, 0, width, height);
  if (vintage) paperGrain();
  ctx.save(); ctx.beginPath(); path(bboxFeature); ctx.clip();
  // Relief's sea floor on its depth scale under everything (quieter on paper); in the terrain view the land on its height scale too
  reliefLevels = { sea: null, land: null, rm: rbase && rbase.rm && rbase.rm.base ? rbase.rm : null };
  const baseImg = rbase && rbase.bases[dark ? "dark" : "light"];
  if (baseImg) {
    const [x0, y0, x1, y1] = doc.relief.extent; const a = proj([x0, y1]), b = proj([x1, y0]);
    ctx.save(); if (vintage) ctx.globalAlpha = 0.6; ctx.drawImage(baseImg, a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.restore();
    if (bands) reliefLevels.land = bandLevels(bands, "land");   // for the terrain key only; the image carries the colour
  } else if (bands) {
    reliefLevels.sea = drawBands(bands, "sea", vintage ? 0.5 : 1);
    if (mode === "terrain") reliefLevels.land = drawBands(bands, "land", vintage ? 0.85 : 1);
  }
  if (!projected) { ctx.beginPath(); path(d3.geoGraticule().step([5, 5])()); ctx.strokeStyle = vintage ? (dark ? "rgba(255,255,255,.12)" : "rgba(80,60,30,.22)") : (dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.06)"); ctx.lineWidth = vintage ? 0.6 : 1; ctx.stroke(); }
  if (!vintage && !projected) { ctx.save(); ctx.shadowColor = dark ? "rgba(0,0,0,.6)" : "rgba(30,40,60,.28)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4; ctx.fillStyle = dark ? "#2a3444" : "#ffffff";
    for (const L of layers) { ctx.beginPath(); for (const f of L.features) if (!f.properties.offshore) path(f); ctx.fill(); } ctx.restore(); }
  const alpha = vintage ? 0.92 : (dark ? 0.72 : 0.85);
  for (const L of (mode === "terrain" ? [] : layers)) {
    for (const f of L.features) {
      const p = f.properties; ctx.beginPath(); path(f);
      ctx.fillStyle = alphaFill(fillOf(p), p.offshore ? alpha * 0.42 : alpha); ctx.fill();
      if (mode === "age+hatch" && p.litho_class !== "ice_water") { const h = hatch(pal.hatch[p.litho_class]); if (h) { ctx.fillStyle = h; ctx.fill(); } }
    }
    ctx.beginPath(); path(L.mesh);
    ctx.strokeStyle = vintage ? (dark ? "rgba(255,255,255,.25)" : "rgba(60,45,30,.45)") : (dark ? "rgba(255,255,255,.14)" : "rgba(255,255,255,.55)"); ctx.lineWidth = vintage ? 0.35 : 0.5; ctx.stroke();
  }
  // Relief hillshade multiplied over the colours: the terrain shows through the geology; strength from the shade control
  if (hill && shade > 0) {
    const [x0, y0, x1, y1] = doc.relief.extent; const a = proj([x0, y1]), b = proj([x1, y0]);
    // soft-light keeps flat ground (mid grey in Relief's shade) unchanged and only darkens shadow slopes and lifts lit ones;
    // "strong" draws it twice and adds a light multiply so ridges bite without muddying the colours
    ctx.save(); ctx.globalCompositeOperation = "soft-light"; ctx.globalAlpha = Math.min(1, shade);
    ctx.drawImage(hill, a[0], a[1], b[0] - a[0], b[1] - a[1]);
    if (shade > 1) { ctx.drawImage(hill, a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = (shade - 1) * 0.6; ctx.drawImage(hill, a[0], a[1], b[0] - a[0], b[1] - a[1]); }
    ctx.restore();
  }
  ctx.restore();
  if (vintage) neatline(pad); else { ctx.beginPath(); path(bboxFeature); ctx.strokeStyle = dark ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.18)"; ctx.lineWidth = 1; ctx.stroke(); }
  legend(chosen); strip(chosen);
}

function paperGrain() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  ctx.save(); ctx.globalAlpha = dark ? 0.05 : 0.07;
  for (let i = 0; i < 1800; i++) { ctx.fillStyle = rnd() > 0.5 ? "#7a6a4a" : "#ffffff"; ctx.fillRect(rnd() * width, rnd() * height, 1.5, 1.5); }
  ctx.restore();
}
function neatline(pad) {
  const ink = dark ? "rgba(235,228,210,.85)" : "#3b3024";
  ctx.strokeStyle = ink; ctx.lineWidth = 1.6; ctx.strokeRect(pad - 10, pad - 10, width - 2 * pad + 20, height - 2 * pad + 20);
  ctx.lineWidth = 0.5; ctx.strokeRect(pad - 5, pad - 5, width - 2 * pad + 10, height - 2 * pad + 10);
  ctx.font = "10px Georgia, serif"; ctx.fillStyle = ink; ctx.textAlign = "center";
  if (!projected) {
    const [w, s, e, n] = doc.bbox;
    for (let lon = Math.ceil(w / 5) * 5; lon <= e; lon += 5) { const p = proj([lon, s]); if (p && p[0] > pad && p[0] < width - pad) ctx.fillText(`${Math.abs(lon)}°${lon < 0 ? "W" : "E"}`, p[0], height - pad + 22); }
    ctx.textAlign = "right";
    for (let lat = Math.ceil(s / 5) * 5; lat <= n; lat += 5) { const p = proj([w, lat]); if (p && p[1] > pad && p[1] < height - pad) ctx.fillText(`${lat}°N`, pad - 14, p[1] + 3); }
  }
  ctx.textAlign = "left"; ctx.fillStyle = ink;
  ctx.font = "500 22px Georgia, serif"; ctx.fillText(doc.name.toUpperCase(), pad + 10, pad + 28);
  const sub = { age: "Bedrock by age, after the International Chronostratigraphic Chart", lithology: "Bedrock by class", "age+hatch": "Age in colour, rock in hatch", tone: "Rock in colour, age in tone (older is darker)", fjord: "Age alone on the fjord ramp (older is darker)", terrain: "Relief terrain: height and depth classes, no bedrock" }[mode];
  ctx.font = "italic 12px Georgia, serif"; ctx.fillText(`${sub} · ${palette} palette`, pad + 10, pad + 46);
}

function legend(chosen) {
  const el = document.getElementById("legend");
  const counts = new Map();
  for (const L of layers) for (const f of L.features) { const k = (mode === "lithology" || mode === "tone") ? f.properties.litho_class : f.properties.ics_display; counts.set(k, (counts.get(k) || 0) + 1); }
  let html;
  const dk = depthKey();
  if (mode === "terrain") {
    html = `<h3>Terrain (Relief) · ${chosen}</h3>` + (reliefLevels.land ? stepStrip("Land, height in m (temperate tints; boreal and tundra ground is greyer)", "land", reliefLevels.land) : "") + (dk ? `<div class="sep"></div>${dk}` : "") +
      `<div class="k" style="margin-top:6px">Relief's Detuned style: stepped height classes cross-blended by climate zone, the sea floor as a linear gradient on the depth scale, hillshade as set above. Bedrock is hidden.</div>`;
    el.innerHTML = html; el.classList.toggle("vintage", frame === "vintage"); el.classList.toggle("dark", dark); return;
  }
  if (mode === "tone") {
    // bivariate grid: rows are classes present, columns are age steps on the same log scale as the fill
    const classes = [...counts].filter(([k]) => k && k !== "ice_water").sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const steps = [3, 30, 300, 1000, 2500];
    const cell = (k, a) => { const c = toneColour({ litho_class: k, age_old_ma: a, age_young_ma: a }); return `<span class="cell" style="background:${c}"></span>`; };
    html = `<h3>Rock in colour, age in tone · ${chosen}</h3><div class="grid"><div class="grow"><span class="glab"></span>${steps.map(s => `<span class="ghead">${s >= 1000 ? (s / 1000) + " Ga" : s + " Ma"}</span>`).join("")}</div>` +
      classes.map(k => `<div class="grow"><span class="glab">${pal.labels[k]}</span>${steps.map(s => cell(k, s)).join("")}</div>`).join("") + `</div><div class="row"><span class="k">lightness runs with log age; the colour is the class</span></div>`;
  } else if (mode === "fjord") {
    const tAt = ma => ageT({ age_old_ma: ma, age_young_ma: ma });
    html = `<h3>Age on the fjord ramp · ${chosen}</h3>` + tickBar("Age of the unit, log scale (older is darker)", fjord, [[3, "3 Ma"], [10, "10"], [30, "30"], [100, "100"], [300, "300 Ma"], [1000, "1 Ga"], [3000, "3 Ga"]].map(([ma, l]) => [tAt(ma), l]));
  } else {
    let rows;
    if (mode === "lithology") rows = [...counts].filter(([k]) => k).sort((a, b) => b[1] - a[1]).map(([k, n]) => [lithoColour({ litho_class: k }), pal.labels[k] || k, n]);
    else {
      rows = [...counts].filter(([k]) => k && doc.chart[k]).sort((a, b) => doc.chart[a[0]].start_ma - doc.chart[b[0]].start_ma)
        .map(([k, n]) => [pal.age[palette][k], `${k} <span class="k">${fmtMa(doc.chart[k].start_ma)}–${fmtMa(doc.chart[k].end_ma)}</span>`, n]);
      if (counts.get(null) || counts.get(undefined)) rows.push([noAge(), "No age read from the source", (counts.get(null) || 0) + (counts.get(undefined) || 0)]);
    }
    let extra = "";
    if (mode === "age+hatch") {
      const present = new Set(); for (const L of layers) for (const f of L.features) present.add(f.properties.litho_class);
      extra = `<h3 style="margin-top:8px">Rock, as hatch</h3>` + [...present].filter(k => k && pal.hatch[k] !== "none").map(k => `<div class="row"><canvas class="sw" data-hatch="${pal.hatch[k]}" width="14" height="14"></canvas><span>${pal.labels[k]}</span></div>`).join("");
    }
    const title = mode === "lithology" ? "Bedrock class" : `Age (${palette === "ics" ? "ICS chart" : palette + " palette"})`;
    html = `<h3>${frame === "vintage" ? "Explication des couleurs" : title} · ${chosen}</h3>` + rows.map(([hex, label, n]) => `<div class="row"><span class="sw" style="background:${hex}"></span><span>${label}</span><span class="n">${n}</span></div>`).join("") + extra;
  }
  // the depth key sits first, above the unit list, which can be long enough to scroll
  el.innerHTML = (dk ? dk + `<div class="sep"></div>` : "") + html;
  el.querySelectorAll("canvas[data-hatch]").forEach(c => { const g = c.getContext("2d"); g.fillStyle = dark ? "#2a3444" : "#fff"; g.fillRect(0, 0, 14, 14); const h = hatch(c.dataset.hatch); if (h) { g.fillStyle = h; g.fillRect(0, 0, 14, 14); } });
  el.classList.toggle("vintage", frame === "vintage"); el.classList.toggle("dark", dark);
}
function fmtMa(v) { return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 2 : 0).replace(/\.?0+$/, "") + " Ga" : (v < 1 ? v.toFixed(v < 0.1 ? 3 : 2) : Math.round(v * 10) / 10) + " Ma"; }

function strip(chosen) {
  const lv = doc.levels[chosen], maps = lv.maps.filter(m => m.file);
  const units = d3.sum(maps, m => m.units_out), bytes = d3.sum(maps, m => m.bytes);
  document.getElementById("strip").innerHTML =
    `<div class="conf"><b>Basis.</b> Observed: the surveys' own map units and words. Derived: chart age and bedrock class read from those words or the surveys' numeric ages; a unit spanning a boundary is coloured by the period at the middle of its span. ${palette === "ics" ? "Colours are the chart's (CGMW)." : `Colours: ${pal.notes[palette]}`}${doc.relief ? " Terrain: " + doc.relief.attribution + "." : ""} Interpreted: none.</div>
     <div>Level <code>${chosen}</code>, designed for 1:${d3.format(",")(lv.scale)}; simplified at ${lv.tolerance_m} m with shared boundaries kept; units under ${lv.min_unit_m2 >= 1e6 ? d3.format(",")(Math.round(lv.min_unit_m2 / 1e6)) : (lv.min_unit_m2 / 1e6).toFixed(2)} km² merged into a neighbour. ${d3.format(",")(units)} units, ${(bytes / 1e6).toFixed(1)} MB${maps.some(m => m.over_budget) ? ` (over the ${lv.budget_mb} MB per-map budget: ${maps.filter(m => m.over_budget).map(m => m.map_id).join(", ")})` : ""}. Built ${doc.built.slice(0, 10)}.</div>
     <div>${maps.map(m => `${m.title} (1:${d3.format(",")(m.source_scale)}; ${m.licence.name}; ${m.licence.status}). ${m.attribution}`).join(" · ")}</div>`;
}
function markLevel(chosen) {
  const el = document.getElementById("levels");
  el.innerHTML = Object.keys(doc.levels).map(k => `<button class="seg" data-level="${k}" aria-pressed="${k === chosen}">${k}</button>`).join("") + `<button class="seg" data-level="" aria-pressed="${!levelName}">auto</button>`;
  el.querySelectorAll("button").forEach(b => b.onclick = () => { levelName = b.dataset.level || null; render(); });
}
function controls() {
  const el = document.getElementById("modes");
  const gap = `<span style="width:10px;display:inline-block"></span>`;
  el.innerHTML = [["age", "age"], ["lithology", "lithology"], ["age+hatch", "age + hatch"], ["tone", "rock + tone"], ["fjord", "fjord"], ...(projected ? [["terrain", "terrain"]] : [])].map(([k, l]) => `<button class="seg" data-mode="${k}" aria-pressed="${k === mode}">${l}</button>`).join("") +
    gap + ["ics", "vintage", "paper"].map(k => `<button class="seg" data-palette="${k}" aria-pressed="${k === palette}">${k}</button>`).join("") +
    gap + ["plain", "vintage"].map(k => `<button class="seg" data-frame="${k}" aria-pressed="${k === frame}">${k} frame</button>`).join("") +
    (projected ? gap + [["0", "no shade"], ["0.6", "soft"], ["0.9", "shade"], ["1.4", "strong"]].map(([k, l]) => `<button class="seg" data-shade="${k}" aria-pressed="${+k === shade}">${l}</button>`).join("") : "");
  el.querySelectorAll("button").forEach(b => b.onclick = () => { if (b.dataset.mode) mode = b.dataset.mode; if (b.dataset.palette) palette = b.dataset.palette; if (b.dataset.frame) frame = b.dataset.frame; if (b.dataset.shade != null) shade = +b.dataset.shade; controls(); render(); });
}

canvas.addEventListener("mousemove", ev => {
  if (!proj) return;
  const r = canvas.getBoundingClientRect(), pt = proj.invert([ev.clientX - r.left, ev.clientY - r.top]);
  if (!pt) { tip.style.display = "none"; return; }
  let hit = null, hitMap = null;
  for (let i = layers.length - 1; i >= 0 && !hit; i--) for (const f of layers[i].features) {
    const [[w, s], [e, n]] = f.bbox; if (pt[0] < w || pt[0] > e || pt[1] < s || pt[1] > n) continue;
    if (projected ? inPolygon(f.geometry, pt) : d3.geoContains(f, pt)) { hit = f; hitMap = layers[i].map; break; }
  }
  if (!hit) { tip.style.display = "none"; return; }
  const p = hit.properties, age = p.age_old_ma != null ? `${fmtMa(p.age_old_ma)} to ${fmtMa(p.age_young_ma)}` : "not read";
  tip.innerHTML = `<b>${p.unit_name || p.unit_id || "unit"}</b><br><span class="k">Age</span> ${p.ics_display || "not read"} · ${age}<br>${p.lithology ? `<span class="k">Lithology</span> ${p.lithology}<br>` : ""}<span class="k">Class</span> ${pal.labels[p.litho_class] || p.litho_class}<br><span class="k">Map</span> ${hitMap.title}`;
  tip.style.display = "block"; tip.style.left = Math.min(ev.clientX - r.left + 14, width - 330) + "px"; tip.style.top = Math.min(ev.clientY - r.top + 14, height - 120) + "px";
});
canvas.addEventListener("mouseleave", () => tip.style.display = "none");
function inPolygon(g, xy) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  for (const rings of polys) if (inRing(rings[0], xy) && !rings.slice(1).some(h => inRing(h, xy))) return true;
  return false;
}
function inRing(ring, [x, y]) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }

controls();
new ResizeObserver(() => requestAnimationFrame(render)).observe(stage);
await render();
