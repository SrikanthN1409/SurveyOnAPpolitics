/* eslint-disable no-console */
import express from "express";
import morgan  from "morgan";
import bodyParser from "body-parser";
import path    from "path";
import { fileURLToPath } from "url";
import crypto  from "crypto";
import dotenv  from "dotenv";
import pg      from "pg";

dotenv.config();

/* ── PostgreSQL pool ──────────────────────────── */
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ── AES helpers ──────────────────────────────── */
const secretKey = crypto.createHash("sha256")
                        .update(process.env.SECRET_PASSPHRASE || "default_pass")
                        .digest();                       // 32‑byte key

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", secretKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

// (Optional) only for local debugging
function decrypt(payload) {
  const [ivHex, data] = payload.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    secretKey,
    Buffer.from(ivHex, "hex")
  );
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/* ── SHA‑256 helper for duplicate check ───────── */
const hash = str => crypto.createHash("sha256").update(str).digest("hex");

/* ── Express setup ───────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app = express();

app.use(morgan("tiny"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");

/* ── ROUTES ───────────────────────────────────── */
app.get("/", (_req, res) => res.render("index"));

app.post("/submit", async (req, res) => {
  console.log("▶️ PROD BODY:", req.body);
  const { name, number, q1, q2, q3, govt_choice, vote_again } = req.body;

  // 🔒 Validate: name present & number exactly 12 digits
  if (!name || !/^\d{10}$/.test(number)) {
    return res.status(400).send("Missing or invalid required fields.");
  }

  const nameHash   = hash(name.toLowerCase());
  const numberHash = hash(number);
  const encName    = encrypt(name);
  const encNumber  = encrypt(number);

  try {
    /* Duplicate guard (OR condition) */
    const dup = await pool.query(
      `SELECT 1 FROM survey_responses
       WHERE name_hash = $1 OR number_hash = $2 LIMIT 1`,
      [nameHash, numberHash]
    );
    if (dup.rowCount) {
      return res.render("already_submitted", { name });
    }

    /* Insert */
    await pool.query(
      `INSERT INTO survey_responses
         (enc_name, enc_number, name_hash, number_hash,
          q1, q2, q3, govt_choice, vote_again)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [encName, encNumber, nameHash, numberHash,
       q1, q2, q3, govt_choice, vote_again]
    );

    /* Aggregate stats */
    const stats = {
      q1: { Yes: 0, No: 0 },
      q2: { Yes: 0, No: 0 },
      q3: { Yes: 0, No: 0 },
      govt_choice: { Kutami: 0, YSRCP: 0, "Both are same": 0 },
      vote_again: { Yes: 0, No: 0 }
    };

    const { rows } = await pool.query(
      `SELECT q1,q2,q3,govt_choice,vote_again FROM survey_responses`
    );
    for (const r of rows) {
      if (r.q1)           stats.q1[r.q1]++;
      if (r.q2)           stats.q2[r.q2]++;
      if (r.q3)           stats.q3[r.q3]++;
      if (r.govt_choice)  stats.govt_choice[r.govt_choice]++;
      if (r.vote_again)   stats.vote_again[r.vote_again]++;
    }

    res.render("thanks", {
      name,
      shareUrl: `${req.protocol}://${req.get("host")}`,
      stats: JSON.stringify(stats)
    });

  } catch (err) {
    console.error("❌ DB Error:", err);
    res.status(500).send("Internal Server Error.");
  }
});

/* ── Start server ─────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ Listening on http://localhost:${PORT}`));
