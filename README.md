# ElevenLabs ↔ GHL Callback Server (Railway) — v2

Two ways to write call outcomes back to GHL:

**A) Direct API (requires Location API Key)**  
Set `GHL_API_KEY` and the server will POST notes to:
`https://services.leadconnectorhq.com/contacts/{id}/notes`

**B) No API Key (Inbound Webhook workflow)**  
Create a Workflow with **Trigger: Inbound Webhook** and actions like **Add/Update Contact** and **Add Note**.  
Copy the webhook URL into `GHL_INBOUND_WEBHOOK_URL`. The server will forward a compact payload:
```json
{
  "contact_id": "...",
  "phone": "+353...",
  "status": "completed",
  "transcript_url": "https://...",
  "note": "AI call status...",
  "reason": "Form callback...",
  "booking_url": "https://..."
}
```

## Endpoints
- `POST /dial` → GHL Webhook hits this; we call ElevenLabs Outbound API.
- `POST /call-events` → ElevenLabs calls this; we write back to GHL using A or B.
- `GET /health` → returns OK.

## GHL Webhook (Outbound) → /dial
Headers:
- `Content-Type: application/json`
- (optional) `X-Auth-Token: <your SHARED_SECRET>`

Body:
```json
{
  "phone": "{{contact.phone}}",
  "first_name": "{{contact.first_name}}",
  "last_name": "{{contact.last_name}}",
  "email": "{{contact.email}}",
  "ghl_contact_id": "{{contact.id}}",
  "opportunity_id": "{{opportunity.id}}",
  "reason": "Form callback within 5 minutes",
  "booking_url": "https://YOUR-GHL-CALENDAR-LINK"
}
```

## Railway Deploy
- Add env vars from `.env.example` (don’t set both GHL modes; pick one).
- After first deploy, set `CALL_EVENTS_URL` to your public URL + `/call-events` and redeploy.
