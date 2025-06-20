import express from "express";
import morgan from "morgan";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import crypto from "crypto";

// ✅ 32-byte key for AES-256
const secretKey = crypto.createHash("sha256").update("your_secure_passphrase").digest(); // 32 bytes
const iv = crypto.randomBytes(16); // 16 bytes

function encrypt(text) {
  const iv = crypto.randomBytes(16);          // ← move this inside
  const cipher = crypto.createCipheriv("aes-256-cbc", secretKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}


function decrypt(encryptedText) {
  const [ivHex, data] = encryptedText.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    secretKey,
    Buffer.from(ivHex, "hex")
  );
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}



const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

/* ────────── middleware ────────── */
app.use(morgan("tiny"));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");

/* ────────── routes ────────── */
app.get("/", (_req, res) => res.render("index"));

app.post("/submit", (req, res) => {
  const { name, number, q1, q2, q3, govt_choice, vote_again } = req.body;
  if (!name || !number || number.length !== 10 || !/^\d{10}$/.test(number)) {
    return res.status(400).send("Missing or invalid required fields.");
  }

  const dbDir = path.join(__dirname, "data");
  const dbPath = path.join(dbDir, "results.json");
  if (!existsSync(dbDir)) mkdirSync(dbDir);

  let db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : [];

  // 🛡️ Check duplicates
// ✅ NEW duplicate logic (OR condition)
const isDuplicate = db.some(entry => {
  try {
    const storedName = decrypt(entry.name);
    const storedNumber = decrypt(entry.number);
    return (
      storedName.toLowerCase() === name.toLowerCase() ||
      storedNumber === number
    );
  } catch (err) {
    return false; // skip corrupted entries
  }
});


  if (isDuplicate) {
    return res.render("already_submitted", { name });
  }

  // 🔐 Encrypt before saving
  const encName = encrypt(name);
  const encNumber = encrypt(number);

  db.push({
    name: encName,
    number: encNumber,
    q1, q2, q3, govt_choice, vote_again,
    ts: Date.now()
  });

  writeFileSync(dbPath, JSON.stringify(db, null, 2));

  // 📊 Aggregate stats
  const stats = {
    q1: { Yes: 0, No: 0 },
    q2: { Yes: 0, No: 0 },
    q3: { Yes: 0, No: 0 },
    govt_choice: { "Kutami": 0, "YSRCP": 0, "Both are same": 0 },
    vote_again: { Yes: 0, No: 0 }
  };

  for (const entry of db) {
    if (entry.q1) stats.q1[entry.q1]++;
    if (entry.q2) stats.q2[entry.q2]++;
    if (entry.q3) stats.q3[entry.q3]++;
    if (entry.govt_choice) stats.govt_choice[entry.govt_choice]++;
    if (entry.vote_again) stats.vote_again[entry.vote_again]++;
  }

  res.render("thanks", {
    name,
    shareUrl: `${req.protocol}://${req.get("host")}`,
    stats: JSON.stringify(stats)
  });
});


/* ────────── server ────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡  Listening on http://localhost:${PORT}`));
