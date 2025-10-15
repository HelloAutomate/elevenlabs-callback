const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

function checkAuth(req, res) {
  const expected = process.env.SHARED_SECRET || "";
  if (!expected) return true;
  const got = req.headers["x-auth-token"];
  if (got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

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
      from: process.env.TWILIO_FROM,
      agent_id: process.env.ELE_AGENT_ID,
      metadata: { first_name, last_name, email, ghl_contact_id, opportunity_id, reason, booking_url, phone },
      webhook_url: process.env.CALL_EVENTS_URL
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

// ElevenLabs → /call-events → GHL (two modes)
//  A) If GHL_API_KEY is set: call LeadConnector contacts/{id}/notes
//  B) Else if GHL_INBOUND_WEBHOOK_URL is set: forward to GHL Inbound Webhook
app.post("/call-events", async (req, res) => {
  const event = req.body || {};
  const { status, transcript_url, metadata } = event;

  res.sendStatus(200); // ack fast
  console.log("ELE event:", JSON.stringify(event));

  const noteText = [
    `AI call status: ${status || "unknown"}`,
    `Transcript: ${transcript_url || "N/A"}`,
    metadata && metadata.reason ? `Reason: ${metadata.reason}` : null
  ].filter(Boolean).join("\n");

  try {
    if (process.env.GHL_API_KEY && metadata && metadata.ghl_contact_id) {
      // Mode A: Direct API
      const resp = await fetch(`https://services.leadconnectorhq.com/contacts/${metadata.ghl_contact_id}/notes`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.GHL_API_KEY}`,
          "Content-Type": "application/json",
          "Version": "2021-07-28"
        },
        body: JSON.stringify({ body: noteText })
      });
      const text = await resp.text();
      console.log("GHL note resp:", resp.status, text);
      return;
    }

    if (process.env.GHL_INBOUND_WEBHOOK_URL) {
      // Mode B: Inbound Webhook (no API key needed)
      const payload = {
        contact_id: metadata && metadata.ghl_contact_id,
        phone: metadata && metadata.phone,
        status: status || "unknown",
        transcript_url: transcript_url || "",
        note: noteText,
        reason: metadata && metadata.reason,
        booking_url: metadata && metadata.booking_url
      };
      const resp = await fetch(process.env.GHL_INBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await resp.text();
      console.log("GHL inbound webhook resp:", resp.status, text);
      return;
    }

    console.log("No GHL_API_KEY or GHL_INBOUND_WEBHOOK_URL set; skipping write-back.");
  } catch (err) {
    console.error("Error posting to GHL:", err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
