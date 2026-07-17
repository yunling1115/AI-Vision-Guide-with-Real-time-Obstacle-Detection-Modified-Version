# AI Vision Guide with Real-time Obstacle Detection

AI Vision Guide is a voice-controlled navigation assistant that combines real-time obstacle detection with conversational route guidance. It closes the gap left by canes, guide dogs, and typical GPS apps by giving hands-free, voice-only destination input and real-time hazard alerts with depth awareness.

## How It Works

1. The user grants camera, microphone, and GPS access in the browser.
2. Camera frames are streamed over two independent, parallel channels:
   - To **Gemini Live** (native audio model), for conversational scene understanding and voice interaction.
   - To the **FastAPI backend** over a dedicated WebSocket (`/ws/vision`), for low-latency obstacle detection (YOLOv8) and depth estimation (MiDaS).
3. The user speaks a destination naturally (e.g. *"take me to the nearest pharmacy"*).
4. Gemini interprets the request via function calling, resolves the location using the Google Maps Places API, and calculates a walking route via OpenRouteService (with Google Directions API as a fallback).
5. Turn-by-turn instructions are spoken aloud through Gemini's TTS, with a browser Speech Synthesis fallback if the TTS call fails or is rate-limited.
6. If the backend detects a nearby hazard (e.g. a person, vehicle, or obstacle within a close distance threshold), the user hears an immediate audio alert plus a short spoken description of what's ahead.

## Key Features

- **Voice-only interaction** — no typing required; destinations, cancellations, and status checks are all spoken.
- **Real-time obstacle detection** — YOLOv8 object detection combined with MiDaS monocular depth estimation to flag nearby hazards.
- **Two independent processing pipelines running in parallel** — Gemini handles high-level scene understanding and dialogue; the backend CV pipeline handles low-latency structured hazard detection (bounding boxes + depth). Neither pipeline blocks or waits on the other.
- **Turn-by-turn voice navigation** — walking-specific routing via OpenRouteService, with live "approaching your turn" proximity alerts.
- **Combined search + navigate tool** — a single function call finds the nearest matching place (e.g. "nearest clinic") and immediately starts navigation, avoiding a slower two-step round trip.
- **Live map view** — Google Maps JavaScript API renders the route, user position, and heading in a dark, high-contrast style, with auto-follow and manual pan/zoom controls.
- **Voice commands mid-navigation** — say "cancel navigation" to clear the current route without disconnecting, or "stop" to end the session entirely.
- **Accessible by design** — screen-reader live regions, large touch targets, and high-contrast visual alerts for low-vision users.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| Voice / NLU | Google Gemini Live API (native audio model) + Gemini TTS |
| Object detection | YOLOv8 (Ultralytics) |
| Depth estimation | MiDaS (small variant) |
| Backend | FastAPI (async, WebSocket streaming) |
| Maps & routing | Google Maps JavaScript API, Places API, Geocoding API, Directions API (fallback) |
| Walking routes | OpenRouteService |

## Architecture Notes

- **Frontend ↔ Backend communication** uses a persistent WebSocket (`ws://localhost:8000/ws/vision`), not polling — the connection stays open, and the backend reacts the instant a new frame is pushed from the frontend's capture loop.
- **Frame capture** runs on a fixed interval (`FRAME_RATE`), draws the current video frame to an off-screen canvas at a fixed resolution, compresses it to JPEG, and sends the same frame to both Gemini and the backend simultaneously — one capture, two independent destinations.
- **Hazard classes** detected by the backend are restricted to a whitelist (see `backend/services/depth_per.py`) tuned primarily for outdoor street navigation (people, vehicles, traffic infrastructure) plus a few indoor items (chairs, potted plants). Expand this list if you need broader indoor hazard coverage.

## Installation & Setup

### Prerequisites

- Node.js and npm
- Python 3.10+
- A Google Cloud project with **Gemini API**, **Maps JavaScript API**, **Places API**, **Geocoding API**, and **Directions API** enabled
- An [OpenRouteService](https://openrouteservice.org/) API key (free tier available)

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend
cp .env_example .env          # then fill in your API keys, see below
npm install
```

### Environment Variables

Create `frontend/.env` with:

```env
VITE_GEMINI_API_KEY=your_gemini_api_key
VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key
VITE_ORS_API_KEY=your_openrouteservice_api_key
```

> **Note:** if `VITE_ORS_API_KEY` is not set, the app automatically falls back to Google's Directions API for walking routes.

## Usage

### Start the backend

```bash
cd backend
venv\Scripts\activate
python main.py
```

The FastAPI server starts on `http://localhost:8000`, exposing the vision WebSocket at `/ws/vision`.

### Start the frontend

```bash
cd frontend
npm run dev
```
