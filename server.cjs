const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// Simple auth (optional but recommended)
function checkAuth(req, res) {
  const expected = process.env.SHARED_SECRET || "";
  if (!expected) return true; // no secret set, skip
  const got = req.headers["x-auth-token"];
  if (got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// Health check
app.get("/health", (_req, res) => res.status(200).send("OK"));

// GHL → /dial → ElevenLabs
app.post("/dial", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { phone, first_name, last_name, email, ghl_contact_id, opportunity_id, reason, booking_url } = req.body || {};

  if (!phone) return res.status(400).send("Missing 'phone' in body");
  if (!process.env.TWILIO_FROM) return res.status(500).send("Server missing TWILIO_FROM");
  if (!process.env.ELE_AGENT_ID) return res.status(500).send("Server missing ELE_AGENT_ID");
  if (!process.env.ELEVENLABS_API_KEY) return res.status(500).send("Server missing ELEVENLABS_API_KEY");

  try {
    const payload = {
      to: phone,
      from: process.env.TWILIO_FROM,       // same number you use for inbound
      agent_id: process.env.ELE_AGENT_ID,  // ElevenLabs agent id
      metadata: {
        first_name, last_name, email, ghl_contact_id, opportunity_id, reason, booking_url
      },
      webhook_url: process.env.CALL_EVENTS_URL // this server's /call-events
    };

    const r = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("ELE error:", r.status, data);
      return res.status(400).json({ error: "ElevenLabs outbound failed", details: data });
    }
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Error calling ElevenLabs:", err);
    res.status(500).json({ error: "Server error", details: String(err) });
  }
});

// ElevenLabs → /call-events → GHL
app.post("/call-events", async (req, res) => {
  const event = req.body || {};
  const { status, transcript_url, metadata } = event;

  // Always ack quickly
  res.sendStatus(200);

  // Log visible in Railway
  console.log("ELE event:", JSON.stringify(event));

  // Optional: write a note back to GHL
  try {
    if (!process.env.GHL_API_KEY || !metadata || !metadata.ghl_contact_id) return;

    const note = [
      `AI call status: ${status || "unknown"}`,
      `Transcript: ${transcript_url || "N/A"}`,
      metadata.reason ? `Reason: ${metadata.reason}` : null
    ].filter(Boolean).join("\n");

    await fetch(`https://services.leadconnectorhq.com/contacts/${metadata.ghl_contact_id}/notes`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GHL_API_KEY}`,
        "Content-Type": "application/json",
        "Version": "2021-07-28"
      },
      body: JSON.stringify({ body: note })
    }).then(r => r.text()).then(t => console.log("GHL note resp:", t));
  } catch (err) {
    console.error("Error posting note to GHL:", err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
