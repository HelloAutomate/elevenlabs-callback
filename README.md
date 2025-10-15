# ElevenLabs ↔ GoHighLevel Callback Server (Railway)

This is a tiny Express app that:
- Receives a **GHL Webhook** at `/dial` and tells **ElevenLabs** to place an **outbound call** using your Twilio number.
- Receives **ElevenLabs call events** at `/call-events` and (optionally) writes a **note** back to the GHL contact.

## Endpoints
- `POST /dial` → Body must include at least `{ "phone": "+1..." }`
- `POST /call-events` → ElevenLabs posts status + transcript here.
- `GET /health` → returns `OK`

## Local Run
```bash
npm install
cp .env.example .env
# fill env values in .env
npm start
# test health: curl http://localhost:8080/health
```

## Railway Deploy
1. Create a new project in Railway and deploy this repo (GitHub or upload).
2. Add the same keys from `.env.example` as **Variables** in Railway.
3. After deploy, set `CALL_EVENTS_URL` to `https://YOUR-SUBDOMAIN.up.railway.app/call-events`.

## GHL Workflow Webhook
- **URL**: `https://YOUR-SUBDOMAIN.up.railway.app/dial`
- **Method**: POST
- **Headers**: `Content-Type: application/json`, `X-Auth-Token: <your SHARED_SECRET>`
- **Body (JSON)**:
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

## Notes
- Use the **same Twilio number** in `TWILIO_FROM` that handles inbound; ElevenLabs will use it for outbound caller ID.
- If you set `SHARED_SECRET`, add the same value as an `X-Auth-Token` header in the GHL Webhook.
