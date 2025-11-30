const express = require("express");
const cors = require("cors");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json()); // în loc de body-parser

const PORT = process.env.PORT || 3001;
const axios = require("axios");
const cheerio = require("cheerio");
// ----------------------
// Site pages for scraping
// ----------------------
const SITE_BASE = "https://petjungle.store";

const POLICY_URLS = {
  shipping: `${SITE_BASE}/policies/shipping-policy`,
  refund: `${SITE_BASE}/policies/refund-policy`,
  privacy: `${SITE_BASE}/policies/privacy-policy`,
  terms: `${SITE_BASE}/policies/terms-of-service`,
  faqs: `${SITE_BASE}/pages/faqs` // dacă nu există, îl prindem în try/catch
};
// ----------------------
// Simple in-memory cache
// ----------------------
let siteCache = {
  shipping: "",
  refund: "",
  privacy: "",
  terms: "",
  faqs: "",
  updatedAt: 0
};

// Fetch & extract readable text from a page
async function fetchPageText(url) {
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    timeout: 15000
  });

  const html = res.data;
  const $ = cheerio.load(html);

  // Shopify are conținutul în general în main / .page-width / .rte
  const main =
    $("main").text() ||
    $(".page-width").text() ||
    $(".rte").text() ||
    $("body").text();

  return main.replace(/\s+/g, " ").trim();
}

// Refresh all relevant pages
async function refreshSiteCache() {
  console.log("Refreshing site cache...");
  try {
    siteCache.shipping = await fetchPageText(POLICY_URLS.shipping);
    siteCache.refund  = await fetchPageText(POLICY_URLS.refund);
    siteCache.privacy = await fetchPageText(POLICY_URLS.privacy);
    siteCache.terms   = await fetchPageText(POLICY_URLS.terms);

    try {
      siteCache.faqs = await fetchPageText(POLICY_URLS.faqs);
    } catch (e) {
      console.warn("FAQ page not found or failed to load.");
      siteCache.faqs = "";
    }

    siteCache.updatedAt = Date.now();
    console.log("Site cache refreshed.");
  } catch (err) {
    console.error("Error refreshing site cache:", err.message);
  }
}

// Auto-refresh la max 1h
async function ensureSiteCacheFresh() {
  const ONE_HOUR = 60 * 60 * 1000;
  if (Date.now() - siteCache.updatedAt > ONE_HOUR) {
    await refreshSiteCache();
  }
}

// Decide ce text este relevant pentru mesaj
function getRelevantSiteInfo(userMessage) {
  const msg = (userMessage || "").toLowerCase();

  if (msg.includes("shipping") || msg.includes("delivery") || msg.includes("ship")) {
    return {
      label: "Shipping Policy",
      url: POLICY_URLS.shipping,
      text: siteCache.shipping
    };
  }

  if (msg.includes("return") || msg.includes("refund")) {
    return {
      label: "Refund / Return Policy",
      url: POLICY_URLS.refund,
      text: siteCache.refund
    };
  }

  if (msg.includes("privacy") || msg.includes("data") || msg.includes("gdpr")) {
    return {
      label: "Privacy Policy",
      url: POLICY_URLS.privacy,
      text: siteCache.privacy
    };
  }

  if (msg.includes("terms") || msg.includes("conditions")) {
    return {
      label: "Terms of Service",
      url: POLICY_URLS.terms,
      text: siteCache.terms
    };
  }

  if (msg.includes("faq") || msg.includes("question") || msg.includes("how")) {
    return {
      label: "FAQs",
      url: POLICY_URLS.faqs,
      text: siteCache.faqs
    };
  }

  return null;
}



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

// ----------------------
// Admin: refresh site cache
// ----------------------
app.post("/api/refresh-site-cache", async (req, res) => {
  const token = req.headers["x-admin-token"];

  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await refreshSiteCache();
    res.json({ message: "Site cache refreshed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to refresh site cache" });
  }
});


// -------------------------
// Endpoint: chat
// -------------------------
// -------------------------
// Endpoint: chat (with site context)
// -------------------------
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message missing" });
  }

  try {
    // ne asigurăm că avem policies în cache
    await ensureSiteCacheFresh();

    // ce parte a site-ului e relevantă pt întrebare
    const relevant = getRelevantSiteInfo(message);

    // contextul tău de bază (din context.txt)
    const baseContext = chatbotContext || "";

    // system prompt
    let systemPrompt = `
You are PawsBot, the AI assistant for the online pet store Pet Jungle (https://petjungle.store).
You answer only using the information given to you below.
Be clear, friendly and concise.

General business / website context:
${baseContext}
`;

    if (relevant && relevant.text) {
      const limitedText = relevant.text.slice(0, 6000); // limităm dimensiunea

      systemPrompt += `

Relevant website section: ${relevant.label}
Source URL: ${relevant.url}

--------------------
${limitedText}
--------------------

When you use this information, always mention the source URL (${relevant.url}) at the end of your answer.
`;
    } else {
      systemPrompt += `

If the website context above does not contain the requested information, say:
"I'm sorry — the website does not provide this information."
`;
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        temperature: 0.3,
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

app.get("/api/scrape", async (req, res) => {
  try {
    const url = "https://petjungle.store/";

    const raw = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    });

    const $ = cheerio.load(raw.data);

    // luăm textul paginii principale (fără scripturi)
    const text = $("body").text().replace(/\s+/g, " ").trim();

    res.json({
      success: true,
      length: text.length,
      sample: text.substring(0, 400) + "..."
    });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
