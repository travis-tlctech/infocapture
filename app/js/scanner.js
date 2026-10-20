// Live QR scanning from the rear camera. Uses the built-in BarcodeDetector
// where the browser has one (Chrome on Android) and the bundled jsQR
// decoder elsewhere (iPhone Safari).

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

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot open the camera. Use "Scan from a photo" instead.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.track = this.stream.getVideoTracks()[0];
    try {
      await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
    } catch {
      // not supported; the camera's default focus is fine
    }
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.detector = await nativeDetector();
    if (!this.detector) this.jsQR = await loadJsQr();
    this.running = true;
    this.loop();
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
// blocked).
export async function decodeQrFromFile(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const detector = await nativeDetector();
  if (detector) {
    const codes = await detector.detect(bitmap);
    if (codes[0]?.rawValue) return codes[0].rawValue;
  }
  const jsQR = await loadJsQr();
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  return code?.data || null;
}
