export function encode(data: Float32Array): string {
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, data[i])) * 0x7fff;
  }
  return btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
}

export function decode(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function decodeAudioData(
  data: ArrayBuffer,
  context: AudioContext,
  sampleRate: number,
  channels: number
): Promise<AudioBuffer> {
  // The Live API returns raw PCM data, not encoded audio like MP3/WAV.
  // We need to wrap it in a Float32Array and create a buffer manually.
  const pcmData = new Int16Array(data);
  const audioBuffer = context.createBuffer(channels, pcmData.length, sampleRate);
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < pcmData.length; i++) {
    channelData[i] = pcmData[i] / 0x7fff;
  }
  return audioBuffer;
}

export function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const pcm = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    pcm[i] = Math.max(-1, Math.min(1, data[i])) * 0x7fff;
  }
  const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));
  return {
    data: base64,
    mimeType: 'audio/pcm;rate=16000',
  };
}
