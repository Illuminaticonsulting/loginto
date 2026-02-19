/**
 * Screen Capture Module
 *
 * Captures the desktop screen as JPEG frames and streams them.
 * Uses screenshot-desktop for cross-platform capture and sharp
 * for fast resizing/compression.
 *
 * Key quality settings (like LogMeIn):
 *  - 4:4:4 chroma subsampling (no color blur on text)
 *  - lanczos3 resampling (sharp downscale, no jagged edges)
 *  - High quality default (92)
 */

const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

class ScreenCapture {
  constructor(options = {}) {
    this.quality = options.quality || 92;
    this.fps = options.fps || 20;
    this.scale = options.scale || 1.0;
    this.streaming = false;
    this.interval = null;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.lastFrame = null;
    this.frameCount = 0;
    this.capturing = false; // prevent overlapping captures

    // Detect screen resolution
    this._detectScreen();
  }

  async _detectScreen() {
    try {
      const img = await screenshot({ format: 'png' });
      const metadata = await sharp(img).metadata();
      this.screenWidth = metadata.width;
      this.screenHeight = metadata.height;
      console.log(`🖥️  Screen detected: ${this.screenWidth}x${this.screenHeight}`);

      // Auto-detect retina: if resolution is very high, scale down to logical pixels
      if (this.scale >= 1.0 && (this.screenWidth > 2500 || this.screenHeight > 1600)) {
        this.scale = 0.5;
        console.log(`🔍 Retina detected — auto-scaling to 0.5x (${Math.round(this.screenWidth * this.scale)}x${Math.round(this.screenHeight * this.scale)})`);
      }
    } catch (err) {
      console.warn('⚠️  Could not detect screen size, using defaults');
    }
  }

  getScreenInfo() {
    const sw = Math.round(this.screenWidth * this.scale);
    const sh = Math.round(this.screenHeight * this.scale);
    return {
      width: this.screenWidth,
      height: this.screenHeight,
      scaledWidth: sw,
      scaledHeight: sh,
      quality: this.quality,
      fps: this.fps,
      scale: this.scale
    };
  }

  setQuality(quality) {
    this.quality = Math.min(100, Math.max(10, quality));
    console.log(`📊 Quality set to ${this.quality}`);
  }

  setFPS(fps) {
    this.fps = Math.min(30, Math.max(1, fps));
    if (this.streaming) {
      clearInterval(this.interval);
      this._startInterval(this._currentCallback);
    }
    console.log(`🎞️  FPS set to ${this.fps}`);
  }

  setScale(scale) {
    this.scale = Math.min(1, Math.max(0.1, scale));
    console.log(`🔍 Scale set to ${this.scale}`);
  }

  startStreaming(callback) {
    if (this.streaming) this.stopStreaming();
    this.streaming = true;
    this._currentCallback = callback;
    this.frameCount = 0;
    console.log(`🎬 Streaming: ${this.fps} FPS, quality ${this.quality}, scale ${this.scale}x, chroma 4:4:4`);
    this._startInterval(callback);
  }

  _startInterval(callback) {
    const intervalMs = Math.round(1000 / this.fps);

    this.interval = setInterval(async () => {
      if (!this.streaming || this.capturing) return;
      this.capturing = true;

      try {
        const frame = await this._captureFrame();
        if (frame && this.streaming) {
          this.frameCount++;
          callback({
            data: frame.toString('base64'),
            width: Math.round(this.screenWidth * this.scale),
            height: Math.round(this.screenHeight * this.scale),
            timestamp: Date.now(),
            frame: this.frameCount
          });
        }
      } catch (err) {
        if (this.frameCount === 0) {
          console.error('❌ Screen capture error:', err.message);
        }
      } finally {
        this.capturing = false;
      }
    }, intervalMs);
  }

  async _captureFrame() {
    const img = await screenshot({ format: 'png' });

    let pipeline = sharp(img);

    // Only resize if scale < 1.0 (saves CPU when sending full res)
    if (this.scale < 0.99) {
      pipeline = pipeline.resize(
        Math.round(this.screenWidth * this.scale),
        Math.round(this.screenHeight * this.scale),
        { fit: 'fill', kernel: sharp.kernel.lanczos3 }
      );
    }

    const frame = await pipeline
      .jpeg({
        quality: this.quality,
        mozjpeg: false,
        chromaSubsampling: '4:4:4'  // Full color — no blur on colored text
      })
      .toBuffer();

    return frame;
  }

  stopStreaming() {
    this.streaming = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log(`⏹️  Streaming stopped (${this.frameCount} frames sent)`);
  }
}

module.exports = ScreenCapture;
