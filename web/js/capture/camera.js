// Camera capture — the browser equivalent of `capture/camera.py`.
//
// Thin wrapper around getUserMedia + a hidden <video> element. Knows nothing
// about the model or the lip math; it only produces frames. Part of the
// separated "sensor" module (camera + model) so the algorithm never touches
// getUserMedia directly.

export class CameraCapture {
  /** @param {{width?: number, height?: number, facingMode?: string}} [opts] */
  constructor(opts = {}) {
    this.width = opts.width ?? 640;
    this.height = opts.height ?? 480;
    // "user" = front camera (phone on desk facing you); "environment" = rear.
    this.facingMode = opts.facingMode ?? "user";
    /** @type {?HTMLVideoElement} */
    this.video = null;
    /** @type {?MediaStream} */
    this._stream = null;
  }

  /** Start the camera and resolve once the video has real dimensions. */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Camera API unavailable. A secure context (https:// or localhost) is required."
      );
    }
    this._stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: this.width },
        height: { ideal: this.height },
        facingMode: this.facingMode,
      },
      audio: false,
    });

    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this._stream;

    await video.play();
    // Wait for real frame dimensions before the model touches it.
    if (!video.videoWidth) {
      await new Promise((resolve) => {
        video.addEventListener("loadeddata", resolve, { once: true });
      });
    }
    this.video = video;
    return video;
  }

  get aspectRatio() {
    if (!this.video || !this.video.videoHeight) return 1.0;
    return this.video.videoWidth / this.video.videoHeight;
  }

  stop() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }
}
