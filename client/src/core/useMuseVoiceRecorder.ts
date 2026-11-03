import { useState, useRef, useCallback } from 'react';
import { apiUrl, apiHeaders } from './apiConfig';

export type MuseVoiceStatus = 'IDLE' | 'RECORDING' | 'TRANSCRIBING';

export interface MuseVoiceResult {
  transcript: string;
  latencyMs: number;
  modelUsed: string;
  biasedKeywordsCount?: number;
}

const TARGET_SAMPLE_RATE = 24000;

function encodeMono16BitWavBase64(samples: Float32Array, sampleRate: number): string {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

async function resampleTo24kHzMono(chunks: Float32Array[], sourceSampleRate: number): Promise<Float32Array> {
  const totalSamples = chunks.reduce((acc, c) => acc + c.length, 0);
  if (totalSamples === 0) return new Float32Array(0);

  const merged = new Float32Array(totalSamples);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.length;
  }

  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    return merged;
  }

  const durationSec = totalSamples / sourceSampleRate;
  const targetLength = Math.max(240, Math.ceil(durationSec * TARGET_SAMPLE_RATE));
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const srcBuffer = offlineCtx.createBuffer(1, totalSamples, sourceSampleRate);
  srcBuffer.copyToChannel(merged, 0);

  const sourceNode = offlineCtx.createBufferSource();
  sourceNode.buffer = srcBuffer;
  sourceNode.connect(offlineCtx.destination);
  sourceNode.start(0);

  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

export function useMuseVoiceRecorder(
  onTranscribed: (res: MuseVoiceResult) => void,
  onError?: (msg: string) => void
) {
  const [voiceStatus, setVoiceStatus] = useState<MuseVoiceStatus>('IDLE');

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(48000);

  const teardownAudioGraph = useCallback(() => {
    try {
      processorRef.current?.disconnect();
    } catch {}
    processorRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError?.('Microphone capture requires HTTPS or localhost.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx: AudioContext = new AudioContextCtor();
      sampleRateRef.current = audioCtx.sampleRate;
      chunksRef.current = [];

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(input));
      };

      const muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;
      source.connect(processor);
      processor.connect(muteGain);
      muteGain.connect(audioCtx.destination);

      streamRef.current = stream;
      audioCtxRef.current = audioCtx;
      processorRef.current = processor;
      setVoiceStatus('RECORDING');
    } catch (err) {
      teardownAudioGraph();
      setVoiceStatus('IDLE');
      onError?.((err as Error).message || 'Microphone permission denied.');
    }
  }, [onError, teardownAudioGraph]);

  const stopAndTranscribe = useCallback(async () => {
    const capturedChunks = [...chunksRef.current];
    const sourceRate = sampleRateRef.current;
    teardownAudioGraph();

    if (capturedChunks.length === 0) {
      setVoiceStatus('IDLE');
      return;
    }

    setVoiceStatus('TRANSCRIBING');
    try {
      const pcm24k = await resampleTo24kHzMono(capturedChunks, sourceRate);
      if (pcm24k.length < TARGET_SAMPLE_RATE * 0.2) {
        setVoiceStatus('IDLE');
        onError?.('Voice clip too short (< 0.2s). Hold longer while speaking.');
        return;
      }

      const wavBase64 = encodeMono16BitWavBase64(pcm24k, TARGET_SAMPLE_RATE);
      const res = await fetch(apiUrl('/api/voice/transcribe'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ wavBase64 }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Muse Voice HTTP ${res.status}`);
      }

      const transcript = String(data.transcript || '').trim();
      if (transcript) {
        onTranscribed({
          transcript,
          latencyMs: Number(data.latencyMs) || 0,
          modelUsed: String(data.modelUsed || 'muse-voice-transcribe-1.0'),
          biasedKeywordsCount: data.biasedKeywordsCount,
        });
      } else {
        onError?.('Muse Voice detected silence — try speaking closer to the mic.');
      }
    } catch (err) {
      onError?.((err as Error).message || 'Muse Voice transcription failed');
    } finally {
      setVoiceStatus('IDLE');
    }
  }, [onError, onTranscribed, teardownAudioGraph]);

  const toggleRecording = useCallback(() => {
    if (voiceStatus === 'TRANSCRIBING') return;
    if (voiceStatus === 'RECORDING') {
      void stopAndTranscribe();
    } else {
      void startRecording();
    }
  }, [startRecording, stopAndTranscribe, voiceStatus]);

  const cancelRecording = useCallback(() => {
    chunksRef.current = [];
    teardownAudioGraph();
    setVoiceStatus('IDLE');
  }, [teardownAudioGraph]);

  return {
    voiceStatus,
    toggleRecording,
    cancelRecording,
  };
}
