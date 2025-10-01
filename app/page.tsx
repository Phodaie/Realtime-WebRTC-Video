'use client';

import { useEffect, useRef, useState } from 'react';

type LogEntry = {
  message: string;
  type: 'system' | 'user' | 'assistant';
  timestamp: Date;
};

type StatusType = 'info' | 'success' | 'error';

type StatusState = {
  message: string;
  type: StatusType;
};

export default function Home() {
  const [hasVideo, setHasVideo] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState<StatusState>({
    message: 'Click "Test Permissions" to start',
    type: 'info',
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [instructions, setInstructions] = useState('You are a helpful assistant. When asked to look at something, describe what you see in the image.');
  const [videoConstraints, setVideoConstraints] = useState({
    width: 1280,
    height: 720,
    frameRate: 30
  });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const addLog = (message: string, type: LogEntry['type'] = 'system') => {
    setLogs(prev => [...prev, { message, type, timestamp: new Date() }]);
  };

  const updateStatus = (message: string, type: StatusType) => {
    setStatus({ message, type });
  };

  const testPermissions = async () => {
    try {
      updateStatus('Testing camera and microphone...', 'info');
      addLog('Requesting permissions...');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: { ideal: videoConstraints.width },
          height: { ideal: videoConstraints.height },
          frameRate: { ideal: videoConstraints.frameRate },
          facingMode: 'user',
        },
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      localStreamRef.current = stream;
      setHasVideo(true);

      addLog('✅ Camera and microphone work!');
      updateStatus('✅ Permissions granted! You can now start a session.', 'success');
    } catch (error) {
      addLog(`❌ Permission test failed: ${(error as Error).message}`);

      try {
        const audioStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });

        localStreamRef.current = audioStream;
        setHasVideo(false);

        addLog('✅ Microphone works! (Camera unavailable)');
        updateStatus('✅ Microphone granted! Running in audio-only mode.', 'success');
      } catch (audioError) {
        updateStatus('❌ Cannot access microphone. Check browser settings.', 'error');
        addLog(`Error: ${(audioError as Error).message}`);
      }
    }
  };

  const startSession = async () => {
    if (!localStreamRef.current) {
      alert('Please test permissions first');
      return;
    }

    try {
      updateStatus('Getting ephemeral token...', 'info');
      
      const sessionResponse = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-realtime-2025-08-28',
          voice: 'alloy',
        }),
      });

      if (!sessionResponse.ok) {
        const error = await sessionResponse.json();
        throw new Error(error.error || 'Failed to get session');
      }

      const session = await sessionResponse.json();
      addLog(`Session created: ${session.id}`);

      updateStatus('Setting up WebRTC...', 'info');
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // Add audio track
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      pc.addTrack(audioTrack, localStreamRef.current);
      addLog('✓ Audio track added');

      // Add video track or transceiver
      if (hasVideo && localStreamRef.current.getVideoTracks().length > 0) {
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        pc.addTrack(videoTrack, localStreamRef.current);
        addLog('✓ Video track added');
      } else {
        pc.addTransceiver('video', { direction: 'recvonly' });
        addLog('✓ Video transceiver added (receive-only)');
      }

      // Handle incoming audio
      pc.ontrack = (event) => {
        addLog('Received audio track from OpenAI');
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
      };

      pc.onconnectionstatechange = () => {
        addLog(`WebRTC connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') {
          setIsConnected(true);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setIsConnected(false);
        }
      };

      // Create data channel
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        addLog('✅ Data channel opened');
        updateStatus('Connected! You can speak now.', 'success');

        // Configure session
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions,
            voice: 'alloy',
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            input_audio_transcription: {
              model: 'whisper-1',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        }));
      };

      dc.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleServerEvent(message);
      };

      dc.onerror = (error) => {
        addLog(`Data channel error: ${error}`);
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') {
              resolve();
            }
          };
        }
      });

      addLog('ICE gathering complete');
      updateStatus('Connecting to OpenAI...', 'info');

      // Send offer to OpenAI
      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.client_secret.value}`,
            'Content-Type': 'application/sdp',
          },
          body: pc.localDescription!.sdp,
        }
      );

      if (!sdpResponse.ok) {
        const errorText = await sdpResponse.text();
        throw new Error(`SDP exchange failed: ${errorText}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });

      addLog('✅ WebRTC connection established!');
    } catch (error) {
      addLog(`❌ Error: ${(error as Error).message}`);
      updateStatus(`Error: ${(error as Error).message}`, 'error');
      stopSession();
    }
  };

  const handleServerEvent = (event: any) => {
    switch (event.type) {
      case 'session.created':
        addLog('✅ Session confirmed by server');
        break;
      case 'session.updated':
        addLog('Session configuration updated');
        break;
      case 'response.audio_transcript.done':
        addLog(`🤖 Assistant: ${event.transcript}`, 'assistant');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        addLog(`👤 You: ${event.transcript}`, 'user');
        break;
      case 'input_audio_buffer.speech_started':
        addLog('🎤 Speech detected');
        break;
      case 'input_audio_buffer.speech_stopped':
        addLog('🔇 Speech ended');
        break;
      case 'response.done':
        addLog('✅ Response completed');
        break;
      case 'error':
        addLog(`❌ Error: ${event.error?.message || 'Unknown error'}`);
        break;
    }
  };

  const stopSession = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    setIsConnected(false);
    setHasVideo(false);
    updateStatus('Session ended. Click "Test Permissions" to start again.', 'info');
    addLog('Session stopped');
  };

  useEffect(() => {
    return () => {
      stopSession();
    };
  }, []);

  const statusThemes = {
    info: {
      icon: '💡',
      badge: 'border border-blue-400/30 bg-blue-500/10 text-blue-100',
    },
    success: {
      icon: '✅',
      badge: 'border border-emerald-400/30 bg-emerald-500/10 text-emerald-100',
    },
    error: {
      icon: '⚠️',
      badge: 'border border-rose-400/30 bg-rose-500/10 text-rose-100',
    },
  } as const;

  const currentStatus = statusThemes[status.type];
  const videoTrackLabel = localStreamRef.current?.getVideoTracks()[0]?.label;
  const hasAnyMedia = Boolean(localStreamRef.current);
  const isAudioOnly = hasAnyMedia && !hasVideo;

  const connectionSummary = [
    {
      label: 'Connection',
      value: isConnected ? 'Live' : 'Idle',
      detail: isConnected ? 'Streaming with OpenAI in realtime.' : 'Waiting to establish a session.',
    },
    {
      label: 'Media Mode',
      value: hasVideo ? 'Video + Audio' : isAudioOnly ? 'Audio only' : 'Not ready',
      detail: hasVideo
        ? 'Camera and microphone are active.'
        : isAudioOnly
        ? 'Microphone ready while camera is unavailable.'
        : 'Run a permissions test to prepare media tracks.',
    },
    {
      label: 'Video Quality',
      value: `${videoConstraints.width}×${videoConstraints.height} @ ${videoConstraints.frameRate}fps`,
      detail: hasVideo ? 'Active video stream settings.' : 'Configured for next session.',
    },
    {
      label: 'Voice',
      value: 'Alloy',
      detail: 'Optimized for natural, fluid responses.',
    },
    {
      label: 'Model',
      value: 'gpt-realtime-2025-08-28',
      detail: 'Realtime multimodal interface (vision + audio).',
    },
  ];

  const logThemes = {
    system: {
      icon: '⚙️',
      wrapper: 'border border-slate-500/30 bg-slate-800/60 text-slate-100',
    },
    user: {
      icon: '🧑',
      wrapper: 'border border-sky-500/30 bg-sky-900/40 text-sky-100',
    },
    assistant: {
      icon: '🤖',
      wrapper: 'border border-purple-500/30 bg-purple-900/40 text-purple-100',
    },
  } as const;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-6">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-white/50">Realtime Studio</p>
            <h1 className="text-2xl font-semibold text-white sm:text-3xl">OpenAI WebRTC Console</h1>
            
          </div>
          <div className={`flex items-center gap-3 rounded-full px-4 py-2 text-sm font-semibold backdrop-blur ${currentStatus.badge}`}>
            <span className="text-xl">{currentStatus.icon}</span>
            <span className="text-white/90">{status.message}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="grid gap-6 lg:grid-cols-[1.3fr,0.7fr]">
          <section className="space-y-6">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 shadow-2xl backdrop-blur">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-6 py-5">
                <div>
                  <h2 className="text-lg font-semibold text-white">Live Preview</h2>
                  <p className="text-sm text-white/50">Confirm your camera and microphone before starting a session.</p>
                </div>
                <div
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
                    hasVideo
                      ? 'border-emerald-400/40 bg-emerald-500/20 text-emerald-100'
                      : isAudioOnly
                      ? 'border-amber-400/40 bg-amber-500/20 text-amber-100'
                      : 'border-slate-400/30 bg-slate-500/10 text-slate-200'
                  }`}
                >
                  <span className="text-base">
                    {hasVideo ? '🎥' : isAudioOnly ? '🎧' : '🛑'}
                  </span>
                  <span>{hasVideo ? 'Video & audio ready' : isAudioOnly ? 'Audio-only mode' : 'Media inactive'}</span>
                </div>
              </div>
              <div className="relative aspect-video bg-slate-900">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                  onLoadedMetadata={(e) => {
                    addLog(`Video loaded: ${e.currentTarget.videoWidth}x${e.currentTarget.videoHeight}`);
                  }}
                  onPlay={() => addLog('Video element started playing')}
                />
                {!hasVideo && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/50">
                    <span className="text-5xl">🎥</span>
                    <p className="text-sm">Camera preview unavailable. Run a permissions test to enable video.</p>
                  </div>
                )}
                {hasVideo && videoTrackLabel && (
                  <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/20 bg-black/70 px-4 py-1 text-xs text-white shadow-lg backdrop-blur">
                    <span className="flex h-2 w-2 items-center justify-center rounded-full bg-emerald-400" />
                    <span className="font-medium">{videoTrackLabel}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <button
                type="button"
                onClick={testPermissions}
                disabled={isConnected}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 px-5 py-5 text-left transition-all hover:-translate-y-1 hover:border-sky-400/40 hover:bg-sky-500/10 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/20 text-2xl text-sky-200">🔍</span>
                  <div>
                    <p className="text-sm font-semibold text-white">Test Permissions</p>
                    <p className="text-xs text-white/60">Verify camera and mic access</p>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={startSession}
                disabled={isConnected || !hasAnyMedia}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-indigo-600 to-purple-600 px-5 py-5 text-left font-semibold transition-all hover:-translate-y-1 hover:shadow-2xl disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 text-2xl text-white">🚀</span>
                  <div>
                    <p className="text-sm text-white">Start Session</p>
                    <p className="text-xs text-white/70">Connect to OpenAI Realtime</p>
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={stopSession}
                disabled={!isConnected}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 px-5 py-5 text-left transition-all hover:-translate-y-1 hover:border-rose-400/40 hover:bg-rose-500/15 hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/20 text-2xl text-rose-200">⏹️</span>
                  <div>
                    <p className="text-sm font-semibold text-white">Stop Session</p>
                    <p className="text-xs text-white/60">End the current connection</p>
                  </div>
                </div>
              </button>
            </div>

            <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur">
              <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
                <div>
                  <h2 className="text-lg font-semibold text-white">Activity Timeline</h2>
                  <p className="text-sm text-white/50">Live transcript of system, user, and assistant events.</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs text-white/60">{logs.length} entries</span>
              </div>
              <div className="max-h-80 overflow-y-auto px-6 py-5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/20">
                {logs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-10 text-center text-white/50">
                    <span className="text-4xl">🗒️</span>
                    <p className="text-sm">No activity yet. Start a session to watch the timeline populate in realtime.</p>
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {logs.map((log, i) => {
                      const theme = logThemes[log.type];
                      return (
                        <li
                          key={`${log.timestamp.getTime()}-${i}`}
                          className={`rounded-2xl px-4 py-3 text-sm shadow-sm ${theme.wrapper}`}
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-lg">{theme.icon}</span>
                            <div className="flex-1">
                              <div className="flex flex-wrap items-baseline gap-2 text-xs text-white/60">
                                <span className="font-mono text-[11px] tracking-tight text-white/50">
                                  {log.timestamp.toLocaleTimeString()}
                                </span>
                                <span className="rounded-full bg-white/10 px-2 py-0.5 capitalize text-[10px] tracking-wide">
                                  {log.type}
                                </span>
                              </div>
                              <p className="mt-1 text-sm text-white/90">{log.message}</p>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur">
              <div className="border-b border-white/10 px-6 py-5">
                <h2 className="text-lg font-semibold text-white">System Instructions</h2>
                <p className="text-sm text-white/50">Configure the assistant’s baseline behavior before you connect.</p>
              </div>
              <div className="space-y-4 px-6 py-5">
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={3}
                  disabled={isConnected}
                  className="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-white/30 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/40 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="Describe how the assistant should behave..."
                />
                <p className="text-xs text-white/40">
                  {isConnected ? 'Instructions are locked while the session is live.' : 'Adjust the prompt to tailor responses before connecting.'}
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur">
              <div className="border-b border-white/10 px-6 py-5">
                <h2 className="text-lg font-semibold text-white">Video Settings</h2>
                <p className="text-sm text-white/50">Adjust video quality before testing permissions.</p>
              </div>
              <div className="space-y-4 px-6 py-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-white/70 mb-2">Resolution</label>
                    <select
                      value={`${videoConstraints.width}x${videoConstraints.height}`}
                      onChange={(e) => {
                        const [width, height] = e.target.value.split('x').map(Number);
                        setVideoConstraints(prev => ({ ...prev, width, height }));
                      }}
                      disabled={isConnected || hasAnyMedia}
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none disabled:opacity-50"
                    >
                      <option value="640x480">640×480 (VGA)</option>
                      <option value="1280x720">1280×720 (HD)</option>
                      <option value="1920x1080">1920×1080 (FHD)</option>
                      <option value="2560x1440">2560×1440 (QHD)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-white/70 mb-2">Frame Rate</label>
                    <select
                      value={videoConstraints.frameRate}
                      onChange={(e) => setVideoConstraints(prev => ({ ...prev, frameRate: Number(e.target.value) }))}
                      disabled={isConnected || hasAnyMedia}
                      className="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-white focus:border-indigo-400 focus:outline-none disabled:opacity-50"
                    >
                      <option value={15}>15 FPS</option>
                      <option value={24}>24 FPS</option>
                      <option value={30}>30 FPS</option>
                      <option value={60}>60 FPS</option>
                    </select>
                  </div>
                </div>
                <p className="text-xs text-white/40">
                  {isConnected || hasAnyMedia 
                    ? 'Video settings are locked once media is active. Stop the session to adjust.'
                    : 'Higher settings may impact performance. Test with your camera capabilities.'
                  }
                </p>
              </div>
            </div>

            <div className="overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-amber-500/15 via-orange-500/10 to-yellow-500/15 text-amber-50">
              <div className="border-b border-white/10 px-6 py-5">
                <h2 className="text-lg font-semibold">Quick Start Checklist</h2>
                <p className="text-sm text-amber-100/80">Follow these steps to get a clean, reliable realtime demo.</p>
              </div>
              <ol className="space-y-4 px-6 py-5 text-sm">
                <li className="flex gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">1</span>
                  <div>
                    <p className="font-semibold">Set credentials</p>
                    <p className="text-amber-100/80">Add your <code className="rounded bg-white/10 px-1">OPENAI_API_KEY</code> to <code className="rounded bg-white/10 px-1">.env.local</code>.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">2</span>
                  <div>
                    <p className="font-semibold">Check devices</p>
                    <p className="text-amber-100/80">Run the permission test while watching the preview feed.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">3</span>
                  <div>
                    <p className="font-semibold">Start streaming</p>
                    <p className="text-amber-100/80">Begin the session and speak naturally—the assistant responds instantly.</p>
                  </div>
                </li>
              </ol>
            </div>

            <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5 backdrop-blur">
              <div className="border-b border-white/10 px-6 py-5">
                <h2 className="text-lg font-semibold text-white">Session Overview</h2>
                <p className="text-sm text-white/50">Key realtime indicators update as you interact with the model.</p>
              </div>
              <div className="space-y-3 px-6 py-5">
                {connectionSummary.map((item) => (
                  <div
                    key={item.label}
                    className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm"
                  >
                    <p className="text-xs uppercase tracking-wide text-white/40">{item.label}</p>
                    <p className="text-base font-semibold text-white">{item.value}</p>
                    <p className="text-xs text-white/50">{item.detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </main>

      <audio ref={remoteAudioRef} autoPlay />
    </div>
  );
}
