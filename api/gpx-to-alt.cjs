// gpx-to-alt.js
// Pipeline : GPX/PGX -> [ {lat, lon, alt} ... ] + GPX avec alt réinjecté
//
// Usage :
//   GOOGLE_MAPS_API_KEY="votre_cle" node gpx-to-alt.js trace.gpx out.json --out-gpx=out_with_alt.gpx
//   # ou
//   node gpx-to-alt.js trace.gpx out.json --key=votre_cle --out-gpx=out_with_alt.gpx
//
// Options :
//   --out-gpx=CHEMIN     Fichier GPX de sortie (par défaut : <base>_with_alt.gpx)
//   --mode=ele|attr      Réinjection en <ele> (défaut) ou attribut alt=""
//   --no-json            N’écrit pas le JSON (si tu ne veux que le GPX modifié)
//
// Dépendances : fast-xml-parser (npm i fast-xml-parser)
// Node 18+ recommandé (fetch global). Si Node <18 : npm i node-fetch et décommente la ligne fetch ci-dessous.

const fs = require("fs");
const path = require("path");
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- CLI args
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node gpx-to-alt.js <input.gpx/pgx> [output.json] [--key=API_KEY] [--out-gpx=FILE] [--mode=ele|attr] [--no-json]");
  process.exit(1);
}
const inputPath = args[0];
const outputJsonPath =
  (!args[1] || args[1].startsWith("--"))
    ? path.join(path.dirname(inputPath), path.basename(inputPath).replace(/\.(gpx|pgx)$/i, "") + "_with_alt.json")
    : args[1];
const keyArg = args.find((a) => a.startsWith("--key="));
const API_KEY = (keyArg && keyArg.split("=")[1]) || process.env.GOOGLE_MAPS_API_KEY;

const outGpxArg = args.find((a) => a.startsWith("--out-gpx="));
const outputGpxPath =
  (outGpxArg && outGpxArg.split("=")[1]) ||
  path.join(path.dirname(inputPath), path.basename(inputPath).replace(/\.(gpx|pgx)$/i, "") + "_with_alt.gpx");

const modeArg = args.find((a) => a.startsWith("--mode="));
const INJECT_MODE = (modeArg && modeArg.split("=")[1]) || "ele"; // "ele" ou "attr"

const NO_JSON = args.includes("--no-json");

if (!API_KEY) {
  console.error("Erreur: clé API manquante. Fournis-la via --key=... ou la variable d'env GOOGLE_MAPS_API_KEY.");
  process.exit(1);
}

// Si Node < 18, décommente la ligne suivante et installe node-fetch :
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- Lire GPX/PGX
let xml;
try {
  xml = fs.readFileSync(inputPath, {encoding:"utf8"});
} catch (e) {
  console.error("Impossible de lire le fichier d'entrée :", e.message);
  process.exit(1);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "", // attributs accessibles via node.lat / node.lon
  allowBooleanAttributes: true,
});
let root;
try {
  root = parser.parse(xml);
} catch (e) {
  console.error("Erreur de parsing XML :", e.message);
  process.exit(1);
}

// --- Collecter tous les <trkpt> en conservant les CHAÎNES d'attributs (pour match strict)
function collectTrkptRefs(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectTrkptRefs(n, out);
    return;
  }
  if (node && typeof node === "object") {
    // un trkpt a des attributs lat/lon (strings)
    if (Object.prototype.hasOwnProperty.call(node, "lat") &&
        Object.prototype.hasOwnProperty.call(node, "lon")) {
      const latStr = String(node.lat);
      const lonStr = String(node.lon);
      const latNum = Number(latStr);
      const lonNum = Number(lonStr);
      if (Number.isFinite(latNum) && Number.isFinite(lonNum)) {
        out.push({ ref: node, latStr, lonStr, latNum, lonNum });
      }
    }
    for (const v of Object.values(node)) collectTrkptRefs(v, out);
  }
}

const trkpts = [];
collectTrkptRefs(root, trkpts);
if (trkpts.length === 0) {
  console.error("Aucun <trkpt lat='' lon=''> trouvé dans le fichier.");
  process.exit(1);
}

// --- Appel Elevation par batch
const BATCH_SIZE = 100; // prudent
const SLEEP_MS = 150;
const RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchElevations(locations) {
  const locParam = locations.map(({ latNum, lonNum }) => `${latNum},${lonNum}`).join("|");
  const url = new URL("https://maps.googleapis.com/maps/api/elevation/json");
  url.searchParams.set("locations", locParam);
  url.searchParams.set("key", API_KEY);

  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString(), { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== "OK") {
        throw new Error(`API status: ${data.status}${data.error_message ? " - " + data.error_message : ""}`);
      }
      return data.results;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRIES) await sleep(250 * attempt);
    }
  }
  throw lastErr;
}

(async function run() {
  // 1) Obtenir les altitudes dans l'ordre des trkpts
  const alts = [];
  for (let i = 0; i < trkpts.length; i += BATCH_SIZE) {
    const batch = trkpts.slice(i, i + BATCH_SIZE);
    const results = await fetchElevations(batch);
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw new Error(`Taille inattendue des résultats API (attendu ${batch.length}, reçu ${results?.length})`);
    }
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      const a = r && Number.isFinite(r.elevation) ? Number(r.elevation) : null;
      const altRounded = a === null ? null : Math.round(a * 10) / 10; // arrondi 0.1 m
      alts.push(altRounded);
    }
    if (i + BATCH_SIZE < trkpts.length) await sleep(SLEEP_MS);
  }

  // 2) Construire le JSON enrichi
  const enriched = trkpts.map((p, idx) => ({
    lat: p.latNum,
    lon: p.lonNum,
    alt: alts[idx],
  }));

  if (!NO_JSON) {
    fs.writeFileSync(outputJsonPath, JSON.stringify(enriched, null, 2), {encoding:"utf8"});
    console.log(`JSON: ${enriched.length} points écrits dans ${outputJsonPath}`);
  }

  // 3) Réinjection dans le GPX
  //    - on privilégie un MATCH STRICT sur les CHAÎNES d'origine (latStr/lonStr)
  //    - on fabrique une map "latStr|lonStr" -> alt
  const mapAlt = new Map();
  for (let i = 0; i < trkpts.length; i++) {
    const key = `${trkpts[i].latStr}|${trkpts[i].lonStr}`;
    mapAlt.set(key, alts[i]);
  }

  let updated = 0;
  for (const p of trkpts) {
    const key = `${p.latStr}|${p.lonStr}`;
    const alt = mapAlt.get(key);
    if (alt == null) continue;

    if (INJECT_MODE === "attr") {
      // Attribut alt="..."
      p.ref.alt = String(alt);
      updated++;
    } else {
      // Élément <ele> standard GPX
      // - si <ele> existe déjà on écrase
      // - sinon on crée
      p.ref.ele = alt;
      updated++;
    }
  }

  // 4) Re-construction du XML
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "", // on conserve les attributs tels quels
    format: true,
    suppressEmptyNode: false,
  });
  let gpxOut = builder.build(root);

  // Ajoute le prologue XML si absent
  if (!gpxOut.trimStart().startsWith("<?xml")) {
    gpxOut = `<?xml version="1.0" encoding="UTF-8"?>\n` + gpxOut;
  }

  fs.writeFileSync(outputGpxPath, gpxOut, {encoding:"utf8"});
  console.log(`GPX: ${updated} trkpt mis à jour -> ${outputGpxPath}`);
})().catch((err) => {
  console.error("Échec :", err.message);
  process.exit(1);
});