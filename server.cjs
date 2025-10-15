// server.cjs
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ---------------------------------
// Optional auth for /dial (X-Auth-Token)
// ---------------------------------
function checkAuth(req, res) {
  const expected = process.env.SHARED_SECRET || "";
  if (!expected) return true; // no secret set -> skip auth
  const got = req.headers["x-auth-token"];
  if (got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------
// Simple phone normalizer → E.164
// ---------------------------------
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/[()\-\s]/g, "");
  if (s.startsWith("+")) return s;

  const region = (process.env.DEFAULT_REGION || "IE").toUpperCase();
  // quick heuristics; extend if needed
  if (region === "IE" && /^0\d{9}$/.test(s)) return "+353" + s.slice(1);
  if (region === "GB" && /^0\d{10}$/.test(s)) return "+44" + s.slice(1);
  if (region === "US" && /^\d{10}$/.test(s)) return "+1" + s;

  return s; // fallback: assume upstream provided E.164
}

// ---------------------------------
app.get("/health", (_req, res) => res.status(200).send("OK"));
// ---------------------------------

// ---------------------------------
// GHL → /dial → ElevenLabs (OUTBOUND CALL)
// ---------------------------------
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

    // optional extras (forwarded to metadata so agent can use them)
    service_selected,
    location_preference,
    appointment_pref,

    // optional per-request agent override
    agent_id_override,
  } = req.body || {};

  const e164 = toE164(phone);
  if (!e164) return res.status(400).send("Missing or invalid 'phone' (must be E.164)");

  // Pick outbound agent if provided, else fallback to default.
  // Also allow a request-time override for testing.
  const agentId =
    agent_id_override ||
    process.env.ELE_OUTBOUND_AGENT_ID ||
    process.env.ELE_AGENT_ID;

  const agentPhoneId = process.env.ELE_AGENT_PHONE_NUMBER_ID; // phnum_...
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const callEventsUrl = process.env.CALL_EVENTS_URL;

  if (!agentId) return res.status(500).send("Missing ELE_OUTBOUND_AGENT_ID or ELE_AGENT_ID");
  if (!agentPhoneId) return res.status(500).send("Missing ELE_AGENT_PHONE_NUMBER_ID");
  if (!apiKey) return res.status(500).send("Missing ELEVENLABS_API_KEY");
  if (!callEventsUrl) return res.status(500).send("Missing CALL_EVENTS_URL");

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
        service_selected,
        location_preference,
        appointment_pref,
        selected_agent_id: agentId, // for debugging
      },
    };

    // Region base (set ELE_API_BASE=https://api.us.elevenlabs.io if you’re on US shard)
    const ELE_BASE = process.env.ELE_API_BASE || "https://api.elevenlabs.io";
    console.log("Using ELE agent:", agentId);
    console.log("POST ELE outbound →", {
      base: ELE_BASE,
      to_number: e164,
      agent_phone_number_id: agentPhoneId,
      agent_id: agentId,
    });

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
      return res
        .status(400)
        .json({ error: "ElevenLabs outbound failed", details: data });
    }
    return res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error("Error calling ElevenLabs:", err);
    return res.status(500).json({ error: "Server error", details: String(err) });
  }
});

// ---------------------------------
// ElevenLabs → /call-events → GHL (write-back)
// Mode A: If GHL_API_KEY set -> create Note via API
// Mode B: Else if GHL_INBOUND_WEBHOOK_URL set -> forward to Inbound Webhook
// ---------------------------------
app.post("/call-events", async (req, res) => {
  const event = req.body || {};
  const { status, transcript_url, metadata } = event;

  // Ack fast so ELE doesn’t retry
  res.sendStatus(200);

  const pieces = [
    `AI call status: ${status || "unknown"}`,
    `Transcript: ${transcript_url || "N/A"}`,
  ];
  if (metadata && metadata.reason) pieces.push(`Reason: ${metadata.reason}`);
  if (metadata && metadata.service_selected) pieces.push(`Service: ${metadata.service_selected}`);
  if (metadata && metadata.location_preference) pieces.push(`Location: ${metadata.location_preference}`);

  const noteText = pieces.join("\n");

  try {
    // Mode A — Direct Notes API (Location key)
    if (process.env.GHL_API_KEY && metadata && metadata.ghl_contact_id) {
      const url = `https://services.leadconnectorhq.com/contacts/${metadata.ghl_contact_id}/notes`;
      const body = { body: noteText };

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_KEY}`,
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
        body: JSON.stringify(body),
      });
      console.log("GHL notes resp:", resp.status, await resp.text());
      return;
    }

    // Mode B — Inbound Webhook (no API key)
    if (process.env.GHL_INBOUND_WEBHOOK_URL) {
      const payload = {
        contact_id: metadata && metadata.ghl_contact_id,
        phone: metadata && metadata.phone,
        first_name: metadata && metadata.first_name,
        last_name: metadata && metadata.last_name,
        email: metadata && metadata.email,

        status: status || "unknown",
        transcript_url: transcript_url || "",
        note: noteText,

        reason: metadata && metadata.reason,
        booking_url: metadata && metadata.booking_url,
        service_selected: metadata && metadata.service_selected,
        location_preference: metadata && metadata.location_preference,
        appointment_pref: metadata && metadata.appointment_pref,
      };

      const resp = await fetch(process.env.GHL_INBOUND_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log("GHL inbound webhook resp:", resp.status, await resp.text());
      return;
    }

    console.log("No GHL sink configured (GHL_API_KEY or GHL_INBOUND_WEBHOOK_URL). Skipping write-back.");
  } catch (err) {
    console.error("Error writing back to GHL:", err);
  }
});

// ---------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on", PORT));
// ---------------------------------
