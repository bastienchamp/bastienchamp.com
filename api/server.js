// api/server.js
import express from "express";
import multer from "multer";
import path from "path";
import { createReadStream } from "fs";
import { readFile, unlink, stat } from "fs/promises";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { execFile } from "child_process";
import cors from "cors";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// (Optionnel) si maps.html est servi sur un autre domaine/port
app.use(cors());

// Sert les fichiers statiques depuis la racine du projet: ./public
app.use(express.static(path.join(process.cwd(), "public")));

const upload = multer({ dest: tmpdir() });

function runNodeScript(args) {
  return new Promise((resolve, reject) => {
    execFile("node", args, { env: process.env }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

// POST /gpx-to-alt  (multipart/form-data, champ "file")
app.post("/gpx-to-alt", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file");
    const mode = req.body.mode === "attr" ? "attr" : "ele"; // default "ele"
    const inputPath = req.file.path;
    const outputPath = path.join(tmpdir(), `${req.file.filename}_with_alt.gpx`);

    // Clé d'élévation côté serveur uniquement
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).send("Server missing GOOGLE_MAPS_API_KEY");
    }

    // Appelle le pipeline, on ne garde que le GPX (pas le JSON)
    const args = [
      path.join(__dirname, "gpx-to-alt.cjs"),
      inputPath,
      "--no-json",
      `--mode=${mode}`,
      `--out-gpx=${outputPath}`,
    ];

    await runNodeScript(args);

    // Renvoie le GPX modifié
    res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${req.file.originalname.replace(/\.gpx$/i, "")}_with_alt.gpx"`
    );

    const gpx = await readFile(outputPath, "utf8"); // ✅ fs/promises
    res.send(gpx);

    // Nettoyage best-effort (promises)
    await Promise.allSettled([unlink(outputPath), unlink(inputPath)]);
  } catch (e) {
    console.error(e);
    res.status(500).send("Processing error");
  }
});

// --- Route GPX sécurisée ---
app.get("/gpx/:name", async (req, res) => {
  try {
    const name = req.params.name;

    // Autoriser seulement *.gpx (pas de traversal)
    if (!/^[A-Za-z0-9._-]+\.gpx$/.test(name)) {
      return res.status(400).send("Bad request");
    }

    // Les fichiers sont dans ./gpx à la racine du projet
    const filePath = path.join(process.cwd(), "gpx", name);

    const st = await stat(filePath).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!st || !st.isFile()) return res.status(404).send("Not found");

    res.setHeader("Content-Type", "application/gpx+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");

    const stream = createReadStream(filePath);
    stream.on("error", () => res.status(500).end("Read error"));
    stream.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error");
  }
});

export default app;