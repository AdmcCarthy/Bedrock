/* One source-to-sink region on Relief's hillshade. Coordinates are the region CRS in metres (d3.geoIdentity, y reflected).
   Data: ../data/derived/<region>/layers.json and the files it lists; Relief layers from the sibling repo (serve the parent).
   Views (fill): cluster | sand | shield | carbonate | age | size | none.  Rivers: network | flow | off.
   Ink: strong (clear blue, firm outlines) | subtle (desaturated, thin, blends with the map).  Shade: 0 to 1.5.
   Fold: hide catchments under a size class so the smallest do not turn the coast to noise. */

const params = new URLSearchParams(location.search);
const region = params.get("r") || "ne_europe";
const base = `data/s2s/${region}/`;
const theme = params.get("theme");
if (theme) document.documentElement.dataset.theme = theme;
const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
let mode = params.get("mode") || "cluster";
let riverMode = params.get("rivers") || "network";
let ink = params.get("ink") || "strong";
let shade = params.has("shade") ? +params.get("shade") : 1.0;
let fold = +(params.get("fold") || 0);        // 0 all, 3 hide under 1,000 km2, 4 hide under 10,000 km2

const doc = await (await fetch(base + "layers.json")).json();
document.getElementById("title").textContent = doc.name; document.title = doc.name;
const stage = document.getElementById("stage"), canvas = document.getElementById("map"), ctx = canvas.getContext("2d"), tip = document.getElementById("tip");

const slopeFlow = doc.slope_flow ? await fetch(base + doc.slope_flow.file).then(r => r.ok ? r.json() : null).catch(() => null) : null;
const [topoS, topoR, outlets, bands] = await Promise.all([
  fetch(base + doc.files.systems).then(r => r.json()), fetch(base + doc.files.rivers).then(r => r.json()),
  fetch(base + doc.files.outlets).then(r => r.json()), fetch(doc.relief.bands).then(r => r.ok ? r.json() : null).catch(() => null),
]);
const systems = topojson.feature(topoS, topoS.objects.systems).features;
const systemMesh = topojson.mesh(topoS, topoS.objects.systems, (a, b) => a !== b);
const rivers = topojson.feature(topoR, topoR.objects.rivers).features;
const hill = new Image(); hill.src = doc.relief.hillshade;
await new Promise(res => { hill.onload = res; hill.onerror = res; });
for (const f of systems) f.bbox = d3.geoPath().bounds(f);

const CL = ["#c8553d", "#3d6e9e", "#7a9a3b", "#b8860b", "#6b4c9a", "#2e8b8b", "#a0522d", "#5f5f5f"];
const SIZE = { "under 1,000 km2": "#dcd6c8", "1,000 to 10,000 km2": "#b9b1a0", "10,000 to 100,000 km2": "#8c8372", "over 100,000 km2": "#5a5247" };
const clusterColour = i => i < 0 ? (dark ? "#555c66" : "#c9ccd1") : CL[i % CL.length];
const ramp = d3.scaleSequential(d3.interpolateViridis).domain([0, 1]);
const ageRamp = d3.scaleSequential(t => d3.interpolateRdYlBu(1 - t)).domain([1, 3.5]);
const qualRamp = d3.scaleSequential(d3.interpolateYlGnBu).domain([0.1, 0.6]);      // sand quality proxy, most catchments fall between
const yieldRamp = d3.scaleSequential(d3.interpolateYlOrBr).domain([0.5, 3]);        // log10 yield t/km2/yr, or log10 sand Mt/yr + 2
const gradRamp = d3.scaleSequential(d3.interpolateViridis).domain([0, 0.08]);       // slope flow gradient (m/m)
const visible = p => (p.log10_area ?? 9) >= fold;

function fillOf(p) {
  if (mode === "none") return null;
  if (p.mapped_frac == null || p.mapped_frac < 0.5) return dark ? "rgba(90,96,106,.55)" : "rgba(200,203,208,.6)";
  if (mode === "cluster") return clusterColour(p.cluster);
  if (mode === "size") return SIZE[p.size_class] || "#999";
  if (mode === "sand") return ramp(p.sand_generating ?? 0);
  if (mode === "shield") return ramp(p.shield_share ?? 0);
  if (mode === "carbonate") return ramp(p.carbonate_source ?? 0);
  if (mode === "age") return p.mean_log10_age_ma != null ? ageRamp(p.mean_log10_age_ma) : "#999";
  if (mode === "quality") return p.sand_quality != null ? qualRamp(p.sand_quality) : "#999";
  if (mode === "yield") return p.yield_t_km2_yr != null ? yieldRamp(Math.log10(Math.max(1, p.yield_t_km2_yr))) : "#999";
  if (mode === "sand") return p.sand_supply_mt_yr != null ? yieldRamp(Math.log10(Math.max(0.001, p.sand_supply_mt_yr)) + 2) : "#999";
  return "#888";
}
const alphaFill = (c, a) => { const k = d3.color(c); if (!k) return c; k.opacity = a; return k.formatRgb(); };
const inkRiver = () => ink === "strong" ? (dark ? "rgba(160,205,255,.9)" : "rgba(30,80,140,.85)") : (dark ? "rgba(190,200,215,.45)" : "rgba(70,90,110,.42)");
const inkEdge = () => ink === "strong" ? (dark ? "rgba(255,255,255,.4)" : "rgba(40,40,40,.5)") : (dark ? "rgba(255,255,255,.18)" : "rgba(60,60,60,.22)");

let proj, path, W, H;
function render() {
  const dpr = devicePixelRatio || 1;
  W = stage.clientWidth; H = stage.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [x0, y0, x1, y1] = doc.extent;
  proj = d3.geoIdentity().reflectY(true).fitExtent([[0, 0], [W, H]], { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
  path = d3.geoPath(proj, ctx);
  const [px0, py1] = proj([x0, y0]), [px1, py0] = proj([x1, y1]);
  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--sea").trim(); ctx.fillRect(0, 0, W, H);
  if (bands) {
    const sea = bands.features.filter(f => f.properties.kind === "sea").sort((a, b) => a.properties.level - b.properties.level);
    for (const f of sea) { ctx.beginPath(); path(f); ctx.fillStyle = dark ? "rgba(24,38,58,.35)" : "rgba(120,160,200,.18)"; ctx.fill(); }
    const land = bands.features.find(f => f.properties.kind === "land" && f.properties.level === 0);
    if (land) { ctx.beginPath(); path(land); ctx.fillStyle = dark ? "rgba(255,255,255,.05)" : "rgba(255,255,255,.35)"; ctx.fill(); }
  }
  // catchments
  const shown = systems.filter(f => visible(f.properties));
  const fa = ink === "strong" ? (dark ? 0.55 : 0.5) : (dark ? 0.35 : 0.3);
  for (const f of shown) { const c = fillOf(f.properties); if (!c) continue; ctx.beginPath(); path(f); ctx.fillStyle = alphaFill(c, fa); ctx.fill(); }
  ctx.save(); ctx.setLineDash(ink === "strong" ? [5, 3] : [3, 3]); ctx.beginPath(); for (const f of shown) path(f); ctx.strokeStyle = inkEdge(); ctx.lineWidth = ink === "strong" ? 0.9 : 0.55; ctx.stroke(); ctx.restore();
  // hillshade multiplied over the fills so the terrain shows through
  if (hill.width && shade > 0) { ctx.save(); ctx.globalCompositeOperation = "soft-light"; ctx.globalAlpha = Math.min(1, shade); ctx.drawImage(hill, px0, py0, px1 - px0, py1 - py0); if (shade > 1) { ctx.drawImage(hill, px0, py0, px1 - px0, py1 - py0); ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = (shade - 1) * 0.6; ctx.drawImage(hill, px0, py0, px1 - px0, py1 - py0); } ctx.restore(); }
  // rivers
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const sysOf = new Map(shown.map(f => [f.properties.system, f.properties]));
  if (riverMode === "network") {
    for (const f of rivers) {
      if (fold && !sysOf.has(f.properties.system)) continue;
      const q = f.properties.log_discharge ?? 0; ctx.beginPath(); path(f); ctx.lineWidth = Math.max(0.3, (ink === "strong" ? 0.25 : 0.15) + (ink === "strong" ? 0.9 : 0.5) * q); ctx.strokeStyle = inkRiver(); ctx.stroke();
    }
  } else if (riverMode === "flow") flowLines(sysOf);
  else if (riverMode === "slope" && slopeFlow) {
    // paths of steepest descent from Relief's terrain, coloured by their mean gradient: the fall lines the rivers follow
    for (const f of slopeFlow.features) {
      const g = f.properties.mean_gradient; ctx.beginPath(); path(f);
      ctx.strokeStyle = alphaFill(gradRamp(g), ink === "strong" ? 0.8 : 0.45); ctx.lineWidth = ink === "strong" ? 0.7 : 0.45; ctx.stroke();
    }
  }
  // outlets
  for (const f of outlets.features) {
    if (fold && !sysOf.has(f.properties.system)) continue;
    const [x, y] = proj(f.geometry.coordinates); const r = Math.max(1.5, Math.sqrt(f.properties.discharge_cms || 1) / 7);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fillStyle = ink === "strong" ? (dark ? "rgba(255,255,255,.9)" : "rgba(20,30,50,.85)") : (dark ? "rgba(255,255,255,.5)" : "rgba(20,30,50,.45)"); ctx.fill();
  }
  ctx.font = "italic 13px Georgia, serif"; ctx.fillStyle = dark ? "rgba(230,235,240,.8)" : "rgba(40,50,60,.8)";
  for (const s of doc.sinks || []) { const p = projLonLat(s.lon, s.lat); if (p) ctx.fillText(s.name, p[0], p[1]); }
  legend(); strip();
}

/* Flow-line view: each reach drawn as a tapered ribbon whose width grows with discharge, in the colour of its catchment's
   group (or the ink), with a soft glow; the network reads as flow converging on the outlet rather than as a wire frame.
   The taper follows seismic_art's cities concept: strokes gain weight as they gather. Smoothing is Chaikin, two passes. */
function flowLines(sysOf) {
  const byQ = rivers.filter(f => !fold || sysOf.has(f.properties.system)).sort((a, b) => (a.properties.log_discharge ?? 0) - (b.properties.log_discharge ?? 0));
  ctx.save();
  for (const pass of ["glow", "core"]) {
    for (const f of byQ) {
      const p = f.properties, q = Math.max(0, p.log_discharge ?? 0);
      const sys = sysOf.get(p.system);
      const col = ink === "strong" ? (sys && sys.cluster >= 0 && mode === "cluster" ? CL[sys.cluster % CL.length] : (dark ? "#a8d0ff" : "#1f5a8f")) : (dark ? "#aab7c6" : "#5c6f82");
      const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const line of lines) {
        const pts = chaikin(line.map(c => proj(c)), 2);
        if (pts.length < 2) continue;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        if (pass === "glow") { ctx.strokeStyle = alphaFill(col, ink === "strong" ? 0.18 : 0.1); ctx.lineWidth = 2.2 + 2.6 * q; }
        else { ctx.strokeStyle = alphaFill(col, ink === "strong" ? 0.95 : 0.55); ctx.lineWidth = 0.4 + 1.3 * q; }
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
function chaikin(pts, n) { for (let k = 0; k < n; k++) { const out = [pts[0]]; for (let i = 0; i < pts.length - 1; i++) { const a = pts[i], b = pts[i + 1]; out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]); } out.push(pts[pts.length - 1]); pts = out; } return pts; }

let lonlat = null;
function projLonLat(lon, lat) { return lonlat ? proj(lonlat(lon, lat)) : null; }
(function () {
  if (doc.crs === "EPSG:3035") lonlat = laea(10, 52, 4321000, 3210000);
  else if (doc.crs.includes("+proj=lcc")) lonlat = lcc(62, 70, 66, 8);
  else if (doc.crs === "EPSG:25832") lonlat = utm(9);
})();
function laea(lon0, lat0, fe, fn) { const R = 6371007.181, d = Math.PI / 180, l0 = lon0 * d, p0 = lat0 * d; return (lon, lat) => { const l = lon * d, p = lat * d; const k = Math.sqrt(2 / (1 + Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0))); return [fe + R * k * Math.cos(p) * Math.sin(l - l0), fn + R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0))]; }; }
function lcc(lat1, lat2, lat0, lon0) { const R = 6371007.181, d = Math.PI / 180, p1 = lat1 * d, p2 = lat2 * d, p0 = lat0 * d, l0 = lon0 * d; const n = Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2)); const F = Math.cos(p1) * Math.pow(Math.tan(Math.PI / 4 + p1 / 2), n) / n, r0 = R * F / Math.pow(Math.tan(Math.PI / 4 + p0 / 2), n); return (lon, lat) => { const r = R * F / Math.pow(Math.tan(Math.PI / 4 + lat * d / 2), n), th = n * (lon * d - l0); return [r * Math.sin(th), r0 - r * Math.cos(th)]; }; }
function utm(lon0) { const d = Math.PI / 180, a = 6378137, f = 1 / 298.257222101, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2); return (lon, lat) => { const p = lat * d, l = (lon - lon0) * d, N = a / Math.sqrt(1 - e2 * Math.sin(p) ** 2), T = Math.tan(p) ** 2, C = ep2 * Math.cos(p) ** 2, A = Math.cos(p) * l; const M = a * ((1 - e2 / 4 - 3 * e2 * e2 / 64) * p - (3 * e2 / 8 + 3 * e2 * e2 / 32) * Math.sin(2 * p) + (15 * e2 * e2 / 256) * Math.sin(4 * p)); return [500000 + k0 * N * (A + (1 - T + C) * A ** 3 / 6), k0 * (M + N * Math.tan(p) * (A * A / 2 + (5 - T + 9 * C) * A ** 4 / 24))]; }; }

function legend() {
  const el = document.getElementById("legend");
  let rows = "";
  if (mode === "cluster") rows = Object.entries(doc.clusters).map(([i, c]) => `<div class="row"><span class="sw" style="background:${clusterColour(+i)}"></span><span>${c.name}</span><span class="n">${c.n_systems}</span></div>`).join("") + `<div class="row"><span class="sw" style="background:${dark ? "#555c66" : "#c9ccd1"}"></span><span>under half of the catchment mapped</span></div>`;
  else if (mode === "size") rows = Object.entries(SIZE).map(([k, c]) => `<div class="row"><span class="sw" style="background:${c}"></span><span>${k}</span><span class="n">${(doc.size_classes || {})[k] || 0}</span></div>`).join("");
  else if (mode !== "none") {
    const label = { sand: "Sand supply proxy, Mt a year (BQART flux times the sand share of the sources)", quality: "Sand quality proxy, 0 to 1 (docs/SAND_QUALITY.md)", yield: "Sediment yield, t per km² a year (BQART)", shield: "Shield share: older Proterozoic and Archean bedrock", carbonate: "Carbonate share", age: "Area-weighted mean bedrock age (log scale)" }[mode];
    const rampOf = t => mode === "age" ? ageRamp(1 + 2.5 * t) : mode === "quality" ? qualRamp(0.1 + 0.5 * t) : mode === "yield" ? yieldRamp(0.5 + 2.5 * t) : mode === "sand" ? yieldRamp(0.5 + 2.5 * t) : ramp(t);
    const stops = d3.range(0, 1.01, 0.1).map(t => `<span style="flex:1;background:${rampOf(t)}"></span>`).join("");
    const ends = mode === "age" ? ["10 Ma", "3 Ga"] : mode === "quality" ? ["0.1", "0.6"] : mode === "yield" ? ["3", "1,000 t/km²/yr"] : mode === "sand" ? ["0.03", "10 Mt/yr"] : ["0", "1"];
    rows = `<div class="k">${label}</div><div class="bar">${stops}</div><div class="ends"><span>${ends[0]}</span><span>${ends[1]}</span></div>`;
  }
  const foldNote = fold ? `<div class="row"><span class="k">catchments under ${fold === 3 ? "1,000" : "10,000"} km² hidden</span></div>` : "";
  el.innerHTML = `<h3>${mode === "cluster" ? "Catchment groups by bedrock and age" : mode === "size" ? "Catchment size, log classes" : mode === "none" ? "Catchments outlined" : "Catchment index"}</h3>${rows}${foldNote}` +
    (riverMode === "flow" ? `<div class="row"><span class="k">flow lines: width and glow grow with mean discharge${mode === "cluster" && ink === "strong" ? ", colour is the catchment group" : ""}</span></div>` : "") +
    (riverMode === "slope" ? `<div class="k" style="margin-top:6px">Slope flow: steepest descent on Relief terrain, colour is the mean gradient</div><div class="bar">${d3.range(0, 1.01, 0.1).map(t => `<span style="flex:1;background:${gradRamp(0.08 * t)}"></span>`).join("")}</div><div class="ends"><span>flat</span><span>8 %</span></div>` : "");
}
function strip() {
  const c = doc.counts;
  document.getElementById("strip").innerHTML = `<div class="conf"><b>Basis.</b> ${doc.basis}</div>
     <div>${c.systems} catchments (river systems over 4,000 km² and coastal groups), ${c.reaches} flow lines with upstream area over 400 km², ${c.outlets} outlets. Size classes on a log scale: ${Object.entries(doc.size_classes || {}).map(([k, v]) => `${v} ${k}`).join(", ")}. Built ${doc.built.slice(0, 10)}.</div>
     <div>${doc.attribution.join(" · ")} · ${doc.relief.attribution}</div>`;
}
function bars(p) {
  const feats = ["igneous_felsic", "igneous_mafic", "gneiss_quartzite", "schist", "clastic", "carbonate", "unconsolidated", "other"];
  const cols = { igneous_felsic: "#e76f51", igneous_mafic: "#5c3d2e", gneiss_quartzite: "#7b8fb5", schist: "#9aa6c4", clastic: "#d9b26f", carbonate: "#9fc5e8", unconsolidated: "#efe6cf", other: "#d9d9d9" };
  const ages = ["Cenozoic", "Mesozoic", "Paleozoic", "Neoproterozoic", "Older_Proterozoic", "Archean", "unread"];
  const acol = { Cenozoic: "#f2f91d", Mesozoic: "#67c5ca", Paleozoic: "#99c08d", Neoproterozoic: "#feb342", Older_Proterozoic: "#f74370", Archean: "#f0047f", unread: "#bbb" };
  const seg = (keys, pre, col) => `<div class="stack">${keys.map(k => { const v = p[pre + k] || 0; return v > 0.005 ? `<span title="${k} ${(100 * v).toFixed(0)}%" style="flex:${v};background:${col[k]}"></span>` : ""; }).join("")}</div>`;
  return `<div class="k">Bedrock</div>${seg(feats, "frac_", cols)}<div class="k">Age</div>${seg(ages, "age_", acol)}`;
}
canvas.addEventListener("mousemove", ev => {
  const r = canvas.getBoundingClientRect(); const xy = proj.invert([ev.clientX - r.left, ev.clientY - r.top]);
  let hit = null;
  for (const f of systems) { if (!visible(f.properties)) continue; const [[w, s], [e, n]] = f.bbox; if (xy[0] < w || xy[0] > e || xy[1] < s || xy[1] > n) continue; if (inPolygon(f.geometry, xy)) { hit = f; break; } }
  if (!hit) { tip.style.display = "none"; return; }
  const p = hit.properties, q = p.discharge_cms != null ? `${Math.round(p.discharge_cms)} m³/s` : "no outlet reach";
  tip.innerHTML = `<b>${p.name}</b> · ${p.kind === "coastal_group" ? "coastal group" : "river system"} · ${d3.format(",")(Math.round(p.area_km2))} km² (${p.size_class})<br><span class="k">Group</span> ${p.cluster_name}<br><span class="k">Mean discharge at mouth</span> ${q}${p.mainstem_km ? ` · main stem ${Math.round(p.mainstem_km)} km` : ""}<br><span class="k">Mapped</span> ${(100 * (p.mapped_frac || 0)).toFixed(0)}% (${p.composition_source})<br>
    ${p.qs_mt_yr != null ? `<span class="k">Budget</span> ${p.qs_mt_yr.toFixed(2)} Mt/yr BQART, ${p.qs_cal_mt_yr != null ? p.qs_cal_mt_yr.toFixed(2) : "?"} calibrated (${Math.round(p.yield_t_km2_yr)} t/km²/yr; Q ${p.q_source}; relief ${Math.round(p.relief_max_m)} m; T ${p.temp_c.toFixed(1)} °C; L ${p.lithology_factor.toFixed(2)})<br><span class="k">Sand</span> quality ${p.sand_quality.toFixed(2)} · share ${(100 * p.sand_share).toFixed(0)}% · ${p.sand_supply_mt_yr.toFixed(2)} Mt/yr${p.glauconite_prone_shelf ? " · low supply: glauconite-prone shelf" : ""}<br>` : ""}${bars(p)}`;
  tip.style.display = "block"; tip.style.left = Math.min(ev.clientX - r.left + 14, W - 340) + "px"; tip.style.top = Math.min(ev.clientY - r.top + 14, H - 170) + "px";
});
canvas.addEventListener("mouseleave", () => tip.style.display = "none");
function inPolygon(g, xy) { const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates; for (const rings of polys) if (inRing(rings[0], xy) && !rings.slice(1).some(h => inRing(h, xy))) return true; return false; }
function inRing(ring, [x, y]) { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }

function controls() {
  const el = document.getElementById("modes"), gap = `<span style="width:10px;display:inline-block"></span>`;
  el.innerHTML = ["cluster", "quality", "yield", "sand", "shield", "carbonate", "age", "size", "none"].map(k => `<button class="seg" data-mode="${k}" aria-pressed="${k === mode}">${k}</button>`).join("") +
    gap + [["network", "rivers"], ["flow", "flow lines"], ["slope", "slope flow"], ["off", "no rivers"]].map(([k, l]) => `<button class="seg" data-rivers="${k}" aria-pressed="${k === riverMode}">${l}</button>`).join("") +
    gap + ["strong", "subtle"].map(k => `<button class="seg" data-ink="${k}" aria-pressed="${k === ink}">${k}</button>`).join("") +
    gap + [["0", "no shade"], ["0.6", "soft"], ["1", "shade"], ["1.4", "strong shade"]].map(([k, l]) => `<button class="seg" data-shade="${k}" aria-pressed="${+k === shade}">${l}</button>`).join("") +
    gap + [["0", "all sizes"], ["3", "≥ 1,000 km²"], ["4", "≥ 10,000 km²"]].map(([k, l]) => `<button class="seg" data-fold="${k}" aria-pressed="${+k === fold}">${l}</button>`).join("");
  el.querySelectorAll("button").forEach(b => b.onclick = () => { if (b.dataset.mode) mode = b.dataset.mode; if (b.dataset.rivers) riverMode = b.dataset.rivers; if (b.dataset.ink) ink = b.dataset.ink; if (b.dataset.shade != null) shade = +b.dataset.shade; if (b.dataset.fold != null) fold = +b.dataset.fold; controls(); render(); });
}
controls();
new ResizeObserver(() => requestAnimationFrame(render)).observe(stage);
render();
