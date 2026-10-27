// Builds the Puzzle Page's map shapes at deploy time (GAMES.md): SVG path data only, from
// public-domain sources, written to site/vendor/maps/ (never committed to git).
//   US states — us-atlas (ISC; Census cartographic boundaries), pre-projected Albers USA
//   Countries — world-atlas (ISC; Natural Earth, public domain), Equal Earth projection
//   NY congressional districts, Dutchess towns — Census 2024 cartographic boundary files
//   Beacon's wards, Dutchess County Legislature districts — Dutchess County GIS (Board of Elections
//   wards; legislative districts with the county's own representative field), fetched as GeoJSON
// Disputed borders follow Natural Earth's de facto view; the page says so.
// Usage: node build-maps.mjs OUT_DIR CENSUS_DIR   (CENSUS_DIR holds the unzipped .shp/.dbf files)
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { geoPath, geoEqualEarth, geoMercator, geoCentroid, geoArea } = await import("d3-geo");
const topojson = require("topojson-client");
const shapefile = require("shapefile");

const [, , OUT, CENSUS] = process.argv;
fs.mkdirSync(OUT, { recursive: true });
const write = (name, obj) => { fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj)); console.log(name, (fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0) + " KB"); };

// ---- US states (pre-projected to 975 × 610)
{
  const us = require("us-atlas/states-albers-10m.json");
  const fc = topojson.feature(us, us.objects.states);
  const p = geoPath().digits(1);
  write("us-states.json", { viewBox: "0 0 975 610", source: "us-atlas (Census cartographic boundaries)", shapes: fc.features.map((f) => ({ id: f.id, name: f.properties.name, d: p(f), c: p.centroid(f).map((x) => Math.round(x)) })) });
}

// ---- Countries (Equal Earth, 960 × 500), with lon/lat centroids for distance-and-direction hints
{
  const w = require("world-atlas/countries-110m.json");
  const fc = topojson.feature(w, w.objects.countries);
  fc.features = fc.features.filter((f) => f.properties.name !== "Antarctica");
  const proj = geoEqualEarth().fitSize([960, 500], fc);
  const p = geoPath(proj).digits(1);
  write("world.json", { viewBox: "0 0 960 500", source: "world-atlas (Natural Earth, public domain); de facto borders",
    shapes: fc.features.map((f) => ({ id: f.id, name: f.properties.name, d: p(f), c: p.centroid(f).map((x) => Math.round(x)), ll: geoCentroid(f).map((x) => Math.round(x * 10) / 10), area: geoArea(f) })) });
}

// ---- Census shapefiles (NY congressional districts; Dutchess County towns and cities)
async function readShp(base) {
  const out = [];
  const src = await shapefile.open(base + ".shp", base + ".dbf");
  for (;;) { const r = await src.read(); if (r.done) break; out.push(r.value); }
  return { type: "FeatureCollection", features: out };
}
if (CENSUS && fs.existsSync(path.join(CENSUS, "cb_2024_us_cd119_500k.shp"))) {
  const cd = await readShp(path.join(CENSUS, "cb_2024_us_cd119_500k"));
  cd.features = cd.features.filter((f) => f.properties.STATEFP === "36");
  let proj = geoMercator().fitSize([600, 520], cd);
  let p = geoPath(proj).digits(1);
  write("ny-districts.json", { viewBox: "0 0 600 520", source: "Census 2024 cartographic boundaries (119th Congress)",
    shapes: cd.features.map((f) => ({ id: "NY-" + Number(f.properties.CD119FP), name: "NY-" + Number(f.properties.CD119FP), d: p(f), c: p.centroid(f).map((x) => Math.round(x)) })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })) });
  const cs = await readShp(path.join(CENSUS, "cb_2024_36_cousub_500k"));
  cs.features = cs.features.filter((f) => f.properties.COUNTYFP === "027");
  proj = geoMercator().fitSize([500, 560], cs);
  p = geoPath(proj).digits(1);
  write("dutchess.json", { viewBox: "0 0 500 560", source: "Census 2024 cartographic boundaries (county subdivisions)",
    shapes: cs.features.map((f) => ({ id: f.properties.GEOID, name: f.properties.NAMELSAD.replace(/ town$/, "").replace(/ city$/, " (city)"), d: p(f), c: p.centroid(f).map((x) => Math.round(x)) })) });
}

// ---- Dutchess County GIS (GeoJSON in CENSUS_DIR): Beacon's four wards; the 25 legislative districts
for (const [file, out, view, src, toShape] of [
  ["beacon-wards.geojson", "beacon-wards.json", [420, 520], "Dutchess County GIS (wards set by the Board of Elections)",
    (f) => ({ id: "w" + f.properties.Ward, name: "Ward " + f.properties.Ward })],
  ["dutchess-ld.geojson", "dutchess-legislature.json", [500, 560], "Dutchess County GIS (County Legislature districts)",
    (f) => ({ id: "ld" + f.properties.DISTRICT, name: "District " + Number(f.properties.DISTRICT), who: f.properties.REPRESENTATIVE || null })],
]) {
  const fp = CENSUS && path.join(CENSUS, file);
  if (!fp || !fs.existsSync(fp)) continue;
  const fc = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!fc.features || !fc.features.length) continue;
  // d3-geo wants clockwise exterior rings; rewind any feature that came out inside-out (area > half the globe).
  for (const f of fc.features) {
    if (geoArea(f) > 2 * Math.PI) {
      const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) for (const ring of poly) ring.reverse();
    }
  }
  const proj = geoMercator().fitSize(view, fc);
  const p = geoPath(proj).digits(1);
  write(out, { viewBox: "0 0 " + view.join(" "), source: src,
    shapes: fc.features.map((f) => Object.assign(toShape(f), { d: p(f), c: p.centroid(f).map((x) => Math.round(x)) })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })) });
}
