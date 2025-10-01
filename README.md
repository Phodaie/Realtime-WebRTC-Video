# OpenAI Realtime WebRTC - Next.js App

A Next.js application that streams video and audio to the OpenAI Realtime API using **WebRTC only** (no WebSocket). Features live camera/microphone capture and real-time conversation with voice responses in a polished operator console.

## Key Features

- ✅ **Pure WebRTC** transport to OpenAI Realtime API
- 🎥 **Video streaming** directly into the realtime model
- 🎤 **Audio streaming** with automatic speech detection
- 🔒 **Secure** - API keys stay server-side
- 🎨 **Modern UI** with Tailwind CSS
- 📱 **Responsive** design

## Architecture

- **Browser**: WebRTC peer connection with video/audio tracks + data channel for events
- **Next.js API Route** (`/api/session`): Mints ephemeral session tokens server-side
- **OpenAI Realtime**: Receives media streams via WebRTC, returns audio responses

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env.local` in the project root:

```bash
OPENAI_API_KEY=sk-your-key-here
```

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Test Permissions**: Click to grant camera and microphone access
2. **Start Session**: Establishes WebRTC connection to OpenAI Realtime API
3. **Speak naturally**: The AI detects speech and responds with audio

## Technical Details

### WebRTC Flow

1. Browser requests ephemeral token from `/api/session`
2. Creates `RTCPeerConnection` with local audio + video tracks
3. Exchanges SDP offer/answer with OpenAI's WebRTC endpoint
4. Opens data channel `oai-events` for control messages
5. Streams media continuously; receives audio responses

### Model

Uses `gpt-realtime-2025-08-28` with:
- Audio format: PCM16
- Voice: Alloy
- Transcription: Whisper-1
- Turn detection: Server-side VAD

### Video Channel

- Camera feed is added as a WebRTC video track
- Continuously streams to the Realtime API for vision-capable models
- Falls back to audio-only if camera unavailable

## Project Structure

```
├── app/
│   ├── api/session/route.ts    # Server-side token minting
│   ├── page.tsx                # Main WebRTC UI component
│   ├── layout.tsx              # Root layout
│   └── globals.css             # Global styles
├── .env.local                  # API key (create this)
├── next.config.js
├── tailwind.config.js
└── package.json
```

## Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Run production build

## Browser Requirements

- Modern browser with WebRTC support (Chrome, Edge, Safari, Firefox)
- HTTPS or localhost (required for camera/microphone access)
- Camera and microphone permissions

## Troubleshooting

**"Cannot access camera"**
- Check browser permissions in system settings
- Ensure you're on localhost or HTTPS
- Close other apps using the camera

**"Failed to create session"**
- Verify `OPENAI_API_KEY` is set in `.env.local`
- Check API key has Realtime API access
- Restart dev server after adding `.env.local`

**No audio response**
- Check browser autoplay settings
- Ensure speakers/headphones are working
- Look for audio track in logs

## Production Deployment

When deploying to production:
1. Set `OPENAI_API_KEY` in your hosting platform's environment variables
2. Ensure your domain uses HTTPS (required for getUserMedia)
3. Run `npm run build` and `npm start`

## License

MIT
