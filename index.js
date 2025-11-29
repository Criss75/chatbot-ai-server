const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json()); // în loc de body-parser

const PORT = process.env.PORT || 3001;

// -------------------------
// Context (informații business)
// -------------------------
const CONTEXT_FILE = path.join(__dirname, "context.txt"); // fișier text simplu

let chatbotContext = "";
if (fs.existsSync(CONTEXT_FILE)) {
  chatbotContext = fs.readFileSync(CONTEXT_FILE, "utf8");
  console.log("Context încărcat din context.txt");
}

// -------------------------
// Endpoint: update context (admin)
// -------------------------
app.post("/api/context", (req, res) => {
  const token = req.headers["x-admin-token"];

  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { context } = req.body;
  if (!context) {
    return res.status(400).json({ error: "Missing context" });
  }

  chatbotContext = context;
  fs.writeFileSync(CONTEXT_FILE, context, "utf8");
  res.json({ message: "Context updated." });
});

// -------------------------
// Endpoint: chat
// -------------------------
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message missing" });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              chatbotContext ||
              "Ești un asistent prietenos pentru un website de business.",
          },
          { role: "user", content: message },
        ],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("OpenAI error:", text);
      return res.status(500).json({ error: "AI error", details: text });
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Nu am un răspuns.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
