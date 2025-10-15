// server.cjs
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ---- tiny auth (optional) ----
function checkAuth(req, res) {
  const expected = process.env.SHARED_SECRET || "";
  if (!expected) return true; // no secret set -> skip
  const got = req.headers["x-auth-token"];
  if (got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---- helpers ----
function toE164(raw) {
  // Keep it simple: accept already-E.164, or IE-style local numbers like 08XXXXXXXX -> +3538XXXXXXXX
  if (!raw) return null;
  const s = String(raw).replace(/[()\-\s]/g, "");
  if (s.startsWith("+")) return s;
  // quick heuristic for IE 10-digit locals e.g. 08xxxxxxxx
  if (process.env.DEFAULT_REGION === "IE" || !process.env.DEFAULT_REGION) {
    if (/^0\d{9}$/.test(s)) return "+353" + s.slice(1);
  }
  return s; // fallback (assume caller sends E.164)
}

// ---- health ----
app.get("/health", (_req, res) => res.status(200).send("OK"));

// ---- GHL → /dial → ElevenLabs (OUTBOUND CALL) ----
app.post("/dial", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const {
    phone,
    first_name,
    last_name,
    email,
    ghl_contact_id,
    opportunity_id,
    reason,
    booking_url,
  } = req.body || {};

  const e164 = toE164(phone);
  if (!e164) return res.status(400).send("Missing or invalid 'phone'");

  // Required env
  const agentId = process.env.ELE_AGENT_ID;
  const agentPhoneId = process.env.ELE_AGENT_PHONE_NUMBER_ID; // phnum_...
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const callEventsUrl = process.env.CALL_EVENTS_URL;

  if (!agentId) return res.status(500).send("Missing ELE_AGENT_ID env var");
  if (!agentPhoneId) return res.status(500).send("Missing ELE_AGENT_PHONE_NUMBER_ID env var");
  if (!apiKey) return res.status(500).send("Missing ELEVENLABS_API_KEY env var");
  if (!callEventsUrl) return res.status(500).send("Missing CALL_EVENTS_URL env var");

  try {
    const payload = {
      to_number: e164,
      agent_phone_number_id: agentPhoneId,
      agent_id: agentId,
      webhook_url: callEventsUrl,
      metadata: {
        first_name,
        last_name,
        email,
        ghl_contact_id,
        opportunity_id,
        reason,
        booking_url,
        phone: e164,
      },
    };

    // Use US shard if you set ELE_API_BASE; otherwise default global
    const ELE_BASE = process.env.ELE_API_BASE || "https://api.elevenlabs.io";
    console.log("POST ELE outbound:", { to_number: e164, agent_phone_number_id: agentPhoneId, agent_id: agentId });

    const r = await fetch(`${ELE_BASE}/v1/convai/twilio/outbound-call`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("ELE error:", r.status, data);
      return res.status(400).json({ error: "ElevenLabs outbound failed", details: data });
    }
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Error calling ElevenLabs:", err);
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

// ---- ElevenLabs → /call-events → GHL (write-back) ----
// Mode A: If GHL_API_KEY set -> create Note via API
// Mode B: Else if GHL_INBOUND_WEBHOOK_URL set -> forward payload to your Inbound Webhook workflow
app.post("/call-events", async (req, res) => {
  const event = req.body || {};
  const { status, transcript_url, metadata } = event;
  res.sendStatus(200); // ack immediately

  const noteText = [
    `AI call status: ${status || "unknown"}`,
    `Transcript: ${transcript_url || "N/A"}`,
    metadata && metadata.reason ? `Reason: ${metadata.reason}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    if (process.env.GHL_API_KEY && metadata && metadata.ghl_contact_id) {
      const resp = await fetch(
        `https://services.leadconnectorhq.com/contacts/${metadata.ghl_contact_id}/notes`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.GHL_API_KEY}`,
            "Content-Type": "application/json",
            Version: "2021-07-28",
          },
          body: JSON.stringify({ body: noteText }),
        }
      );
      console.log("GHL notes resp:", resp.status, await resp.text());
      return;
    }

    if (process.env.GHL_INBOUND_WEBHOOK_URL) {
      const payload = {
        contact_id: metadata && metadata.ghl_contact_id,
        phone: metadata && metadata.phone,
        status: status || "unknown",
        transcript_url: transcript_url || "",
        note: noteText,
        reason: metadata && metadata.reason,
        booking_url: metadata && metadata.booking_url,
      };
      const resp = await fetch(process.env.GHL_INBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("GHL inbound webhook resp:", resp.status, await resp.text());
      return;
    }

    console.log("No GHL_API_KEY or GHL_INBOUND_WEBHOOK_URL set; skipping write-back.");
  } catch (err) {
    console.error("Error writing back to GHL:", err);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
