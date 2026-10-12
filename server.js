
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const Database = require("better-sqlite3");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Validate required configuration
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error(
    "Set JWT_SECRET in .env to a random string at least 32 characters long."
  );
  process.exit(1);
}

// Create the database directory and database
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "medfusion.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    appointment_date TEXT NOT NULL,
    reason TEXT NOT NULL,
    token_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'Waiting',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    medicine_name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    reminder_time TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  })
);

// Image upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Upload a JPG, PNG, or WEBP image only."));
    }
    cb(null, true);
  },
});

// Authentication middleware
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  try {
    if (!token) throw new Error("Missing token");
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Please sign in again." });
  }
}

function validEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.length <= 254
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}

// AI client: Ollama local model or OpenAI API
function getAIClient() {
  if (process.env.AI_PROVIDER === "ollama") {
    return new OpenAI({
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
    });
  }

  if (
    !process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY.startsWith("replace_")
  ) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, app: "AI-MedFusion" });
});

// Register
app.post("/api/auth/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 80) {
      return res.status(400).json({
        error: "Name must be 2–80 characters.",
      });
    }

    if (!validEmail(email)) {
      return res.status(400).json({
        error: "Enter a valid email address.",
      });
    }

    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({
        error: "Password must be 8–128 characters.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db
      .prepare(
        "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)"
      )
      .run(name, email, passwordHash);

    const user = db
      .prepare("SELECT id, name, email FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.status(201).json({ token, user });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({
        error: "An account with this email already exists.",
      });
    }

    console.error("Registration error:", err.message);
    res.status(500).json({ error: "Could not create account." });
  }
});

// Login
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Invalid email or password.",
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Could not log in." });
  }
});

// Current user
app.get("/api/me", auth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, email FROM users WHERE id = ?")
    .get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: "User not found." });
  }

  res.json({ user });
});

// Create appointment
app.post("/api/appointments", auth, (req, res) => {
  const appointmentDate = String(req.body.appointmentDate || "");
  const reason = String(req.body.reason || "").trim();

  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(appointmentDate) ||
    appointmentDate < new Date().toISOString().slice(0, 10)
  ) {
    return res.status(400).json({
      error: "Choose today or a future date.",
    });
  }

  if (reason.length < 3 || reason.length > 300) {
    return res.status(400).json({
      error: "Reason must be 3–300 characters.",
    });
  }

  const tokenNumber = db
    .prepare(
      "SELECT COALESCE(MAX(token_number), 0) + 1 AS next FROM appointments WHERE appointment_date = ?"
    )
    .get(appointmentDate).next;

  const result = db
    .prepare(
      "INSERT INTO appointments (user_id, appointment_date, reason, token_number) VALUES (?, ?, ?, ?)"
    )
    .run(req.user.id, appointmentDate, reason, tokenNumber);

  const appointment = db
    .prepare(
      "SELECT id, appointment_date, reason, token_number, status FROM appointments WHERE id = ?"
    )
    .get(result.lastInsertRowid);

  res.status(201).json({ appointment });
});

// List the signed-in user's appointments
app.get("/api/appointments", auth, (req, res) => {
  const appointments = db
    .prepare(
      `SELECT id, appointment_date, reason, token_number, status, created_at
       FROM appointments
       WHERE user_id = ?
       ORDER BY appointment_date DESC, id DESC
       LIMIT 50`
    )
    .all(req.user.id);

  res.json({ appointments });
});

// Appointment queue for a date
app.get("/api/queue/:date", auth, (req, res) => {
  const date = req.params.date;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      error: "Use date format YYYY-MM-DD.",
    });
  }

  const rows = db
    .prepare(
      "SELECT token_number, status FROM appointments WHERE appointment_date = ? ORDER BY token_number"
    )
    .all(date);

  const current =
    rows.find((row) => row.status === "In consultation")?.token_number ||
    null;

  const next =
    rows.find((row) => row.status === "Waiting")?.token_number || null;

  res.json({
    date,
    currentToken: current,
    nextToken: next,
    waitingCount: rows.filter((row) => row.status === "Waiting").length,
  });
});

// Demo status update. Add proper staff roles before public deployment.
app.patch("/api/appointments/:id/status", auth, (req, res) => {
  const allowed = [
    "Waiting",
    "In consultation",
    "Completed",
    "Cancelled",
  ];

  const status = String(req.body.status || "");

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const appointment = db
    .prepare(
      "SELECT id FROM appointments WHERE id = ? AND user_id = ?"
    )
    .get(Number(req.params.id), req.user.id);

  if (!appointment) {
    return res.status(404).json({
      error: "Appointment not found.",
    });
  }

  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(
    status,
    appointment.id
  );

  res.json({ ok: true });
});

// Create a medicine reminder
app.post("/api/reminders", auth, (req, res) => {
  const medicineName = String(req.body.medicineName || "").trim();
  const instructions = String(req.body.instructions || "").trim();
  const reminderTime = String(req.body.reminderTime || "").trim();

  if (medicineName.length < 2 || medicineName.length > 100) {
    return res.status(400).json({
      error: "Enter a medicine name.",
    });
  }

  if (!/^\d{2}:\d{2}$/.test(reminderTime)) {
    return res.status(400).json({
      error: "Choose a valid reminder time.",
    });
  }

  const [hours, minutes] = reminderTime.split(":").map(Number);
  if (hours > 23 || minutes > 59) {
    return res.status(400).json({
      error: "Choose a valid reminder time.",
    });
  }

  if (instructions.length > 250) {
    return res.status(400).json({
      error: "Instructions are too long.",
    });
  }

  const result = db
    .prepare(
      "INSERT INTO reminders (user_id, medicine_name, instructions, reminder_time) VALUES (?, ?, ?, ?)"
    )
    .run(req.user.id, medicineName, instructions, reminderTime);

  const reminder = db
    .prepare(
      "SELECT id, medicine_name, instructions, reminder_time, active FROM reminders WHERE id = ?"
    )
    .get(result.lastInsertRowid);

  res.status(201).json({ reminder });
});

// List medicine reminders
app.get("/api/reminders", auth, (req, res) => {
  const reminders = db
    .prepare(
      `SELECT id, medicine_name, instructions, reminder_time, active
       FROM reminders
       WHERE user_id = ?
       ORDER BY reminder_time`
    )
    .all(req.user.id);

  res.json({ reminders });
});

// Delete a medicine reminder
app.delete("/api/reminders/:id", auth, (req, res) => {
  const result = db
    .prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?")
    .run(Number(req.params.id), req.user.id);

  if (!result.changes) {
    return res.status(404).json({ error: "Reminder not found." });
  }

  res.json({ ok: true });
});

// AI healthcare chatbot
app.post("/api/chat", auth, async (req, res) => {
  const message = String(req.body.message || "").trim();

  if (!message || message.length > 2000) {
    return res.status(400).json({
      error: "Message must be 1–2000 characters.",
    });
  }

  const ai = getAIClient();

  if (!ai) {
    return res.status(503).json({
      error: "AI is not configured. Check your .env settings.",
    });
  }

  try {
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "llama3.2",
      messages: [
        {
          role: "system",
          content:
            "You are an educational healthcare information assistant. Give general information only. Do not diagnose diseases, prescribe medicines, or recommend dosages. Encourage users to consult a licensed clinician for symptoms or treatment decisions. For emergencies, advise contacting local emergency services. Clearly state that you are an AI, not a doctor.",
        },
        { role: "user", content: message },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });

    res.json({
      answer:
        completion.choices[0]?.message?.content ||
        "I couldn't create a response.",
    });
  } catch (err) {
    console.error("Chat API error:", err.message);
    res.status(502).json({
      error:
        "The AI service could not respond. Check that Ollama is running and the selected model is installed.",
    });
  }
});

// Optional image description endpoint.
// Requires a compatible vision model if using Ollama.
app.post(
  "/api/image-analysis",
  auth,
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Choose a JPG, PNG, or WEBP image.",
      });
    }

    const ai = getAIClient();

    if (!ai) {
      return res.status(503).json({
        error: "AI is not configured. Check your .env settings.",
      });
    }

    const dataUrl =
      `data:${req.file.mimetype};base64,` +
      req.file.buffer.toString("base64");

    try {
      const completion = await ai.chat.completions.create({
        model:
          process.env.OPENAI_VISION_MODEL ||
          process.env.OPENAI_CHAT_MODEL ||
          "llama3.2",
        messages: [
          {
            role: "system",
            content:
              "You are assisting with an educational prototype, not a clinical diagnostic device. Do not diagnose disease, estimate disease probabilities, or recommend treatment from an image. Describe only general visible characteristics and image quality. Recommend review by a qualified clinician. AI output must not be used for medical decisions.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Briefly describe this image without diagnosing any disease. " +
                  "Suggest questions the patient could ask a clinician.",
              },
              {
                type: "image_url",
                image_url: { url: dataUrl, detail: "low" },
              },
            ],
          },
        ],
        max_tokens: 350,
        temperature: 0.2,
      });

      res.json({
        result:
          completion.choices[0]?.message?.content ||
          "No description was returned.",
        disclaimer:
          "Educational prototype only. Not a diagnosis or a clinically validated medical image analysis. Consult a qualified clinician.",
      });
    } catch (err) {
      console.error("Vision API error:", err.message);
      res.status(502).json({
        error:
          "Image analysis failed. Check that the selected model supports images.",
      });
    }
  }
);

// Handle upload and request errors
app.use((err, _req, res, _next) => {
  if (
    err instanceof multer.MulterError &&
    err.code === "LIMIT_FILE_SIZE"
  ) {
    return res.status(413).json({
      error: "Image must be 5 MB or smaller.",
    });
  }

  if (err) {
    return res.status(400).json({
      error: err.message || "Bad request.",
    });
  }

  res.status(500).json({ error: "Unexpected server error." });
});

// Start the server
app.listen(PORT, () => {
  console.log(`AI-MedFusion running at http://localhost:${PORT}`);
});
