// Live QR scanning from the rear camera. Uses the built-in BarcodeDetector
// where the browser has one (Chrome on Android) and the bundled jsQR
// decoder elsewhere (iPhone Safari).

import { loadBitmap } from './image.js';

let jsQrPromise;

function loadJsQr() {
  jsQrPromise ??= new Promise((resolve, reject) => {
    if (window.jsQR) return resolve(window.jsQR);
    const s = document.createElement('script');
    s.src = new URL('../vendor/jsQR.min.js', import.meta.url).href;
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => {
      jsQrPromise = null;
      reject(new Error('Could not load the QR decoder.'));
    };
    document.head.append(s);
  });
  return jsQrPromise;
}

async function nativeDetector() {
  try {
    if (!('BarcodeDetector' in window)) return null;
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code') ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
  } catch {
    return null;
  }
}

export class QrScanner {
  constructor(video, onResult) {
    this.video = video;
    this.onResult = onResult;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false;
    this.frame = 0;
  }

  // Resolves true once the preview is playing, false when the browser wants
  // a tap first (some iPhones); see resume().
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot open the camera. Use "Scan from a photo" instead.');
    }
    const v = this.video;
    // iPhones only play a camera preview inline and silently with all three
    // set before the stream is attached.
    v.setAttribute('playsinline', '');
    v.setAttribute('autoplay', '');
    v.muted = true;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.track.addEventListener('ended', () => this.onEnded?.());
    v.srcObject = this.stream;
    const playing = await this.resume();
    // Continuous focus only where the camera offers it. iPhones focus on
    // their own, and changing camera settings there can stall the preview.
    try {
      if (this.track.getCapabilities?.().focusMode?.includes('continuous')) {
        this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
    } catch {
      // capabilities not available; keep the camera's defaults
    }
    this.detector = await nativeDetector();
    if (!this.detector) this.jsQR = await loadJsQr();
    this.running = true;
    this.loop();
    return playing;
  }

  async resume() {
    try {
      await this.video.play();
      return true;
    } catch {
      return false;
    }
  }

  hasPicture() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  async waitForPicture(ms) {
    const until = Date.now() + ms;
    while (!this.hasPicture() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return this.hasPicture();
  }

  // Opens the camera again (after iOS stopped it, or nothing showed).
  async restart() {
    this.stop();
    return this.start();
  }

  loop() {
    if (!this.running) return;
    this.decode()
      .then((text) => {
        if (text && this.running) {
          this.stop();
          this.onResult(text);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.running) this.timer = setTimeout(() => this.loop(), 90);
      });
  }

  async decode() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    if (this.detector) {
      const codes = await this.detector.detect(v);
      return codes[0]?.rawValue || null;
    }
    // jsQR: decode the centre of the frame, where the viewfinder is. Every
    // third frame also tries light-on-dark codes.
    const side = Math.min(v.videoWidth, v.videoHeight) * 0.85;
    const size = Math.min(900, Math.round(side));
    this.canvas.width = size;
    this.canvas.height = size;
    this.ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
    const img = this.ctx.getImageData(0, 0, size, size);
    this.frame += 1;
    const code = this.jsQR(img.data, size, size, {
      inversionAttempts: this.frame % 3 === 0 ? 'attemptBoth' : 'dontInvert',
    });
    return code?.data || null;
  }

  torchSupported() {
    try {
      return Boolean(this.track?.getCapabilities?.().torch);
    } catch {
      return false;
    }
  }

  async setTorch(on) {
    await this.track.applyConstraints({ advanced: [{ torch: on }] });
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

// Decodes a QR code from a still photo (fallback when live camera access is
// blocked). A phone photo is looked at several ways, most likely first: at
// 1600 px most badges read; near full size finds a small or distant code;
// a centre crop helps when the code is in the middle of a busy picture.
const PHOTO_PASSES = [
  { crop: 1, edge: 1600 },
  { crop: 1, edge: 3000 },
  { crop: 0.6, edge: 1400 },
  { crop: 1, edge: 900 },
];

export async function decodeQrFromFile(file) {
  const image = await loadBitmap(file);
  try {
    const detector = await nativeDetector();
    if (detector) {
      try {
        const codes = await detector.detect(image);
        if (codes[0]?.rawValue) return codes[0].rawValue;
      } catch {
        // fall through to jsQR
      }
    }
    const jsQR = await loadJsQr();
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tried = new Set();
    for (const { crop, edge } of PHOTO_PASSES) {
      const cw = Math.round(width * crop);
      const ch = Math.round(height * crop);
      const scale = Math.min(1, edge / Math.max(cw, ch));
      const w = Math.round(cw * scale);
      const h = Math.round(ch * scale);
      const key = `${crop}:${w}`;
      if (tried.has(key)) continue;
      tried.add(key);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(image, (width - cw) / 2, (height - ch) / 2, cw, ch, 0, 0, w, h);
      const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      if (code?.data) return code.data;
    }
    return null;
  } finally {
    image.close?.();
  }
}
