import { useState, useRef, useCallback, useEffect } from 'react';

const MAX_FRAME_SIDE = 960;
const DEFAULT_BENCHMARK_SCENE = '/hardware-bench1.jpg';

export type CameraFeedMode = 'OFF' | 'WEBCAM' | 'SIMULATED_30FPS';

export function useSpatialCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneImgRef = useRef<HTMLImageElement | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const simCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRafRef = useRef<number | null>(null);
  const simPausedRef = useRef<boolean>(false);
  const simTransformRef = useRef<{ panX: number; panY: number; zoom: number }>({
    panX: 0,
    panY: 0,
    zoom: 1.015,
  });

  const [uploadedImage, setUploadedImage] = useState<string | null>(DEFAULT_BENCHMARK_SCENE);
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraFeedMode>('OFF');

  const cleanupStreams = useCallback(() => {
    if (simRafRef.current !== null) {
      cancelAnimationFrame(simRafRef.current);
      simRafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    cleanupStreams();
    setCameraActive(false);
    setCameraMode('OFF');
  }, [cleanupStreams]);

  const drawSimulatedFrame = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number, nowMs: number, includeHudOverlay: boolean) => {
      const img = sceneImgRef.current;
      if (!img || !img.complete || img.naturalWidth === 0) return;

      const t = nowMs / 1000;
      if (!simPausedRef.current) {
        simTransformRef.current = {
          panX: Math.sin(t * 1.15) * (w * 0.0055) + Math.cos(t * 2.3) * (w * 0.0015),
          panY: Math.cos(t * 0.85) * (h * 0.005) + Math.sin(t * 1.9) * (h * 0.0015),
          zoom: 1.018 + Math.sin(t * 0.55) * 0.0045,
        };
      }

      const { panX, panY, zoom } = simTransformRef.current;
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.translate(w / 2 + panX, h / 2 + panY);
      ctx.scale(zoom, zoom);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();

      if (includeHudOverlay) {
        // Subtle optical scanline sweep
        const scanY = ((nowMs * 0.14) % (h + 40)) - 20;
        const grad = ctx.createLinearGradient(0, scanY - 14, 0, scanY + 14);
        grad.addColorStop(0, 'rgba(34, 211, 238, 0)');
        grad.addColorStop(0.5, 'rgba(34, 211, 238, 0.06)');
        grad.addColorStop(1, 'rgba(34, 211, 238, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, scanY - 14, w, 28);

        // Top-left optical sensor telemetry pill (outside product area)
        const totalFrames = Math.floor(t * 30);
        const ff = String(totalFrames % 30).padStart(2, '0');
        const ss = String(Math.floor(t) % 60).padStart(2, '0');
        const mm = String(Math.floor(t / 60) % 60).padStart(2, '0');
        const fontSize = Math.max(11, Math.round(w * 0.0115));

        ctx.save();
        ctx.fillStyle = 'rgba(5, 8, 12, 0.78)';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
        ctx.lineWidth = 1;
        const boxW = Math.round(fontSize * 29);
        const boxH = Math.round(fontSize * 2.1);
        ctx.fillRect(14, 14, boxW, boxH);
        ctx.strokeRect(14, 14, boxW, boxH);

        // Pulsing REC dot
        ctx.beginPath();
        ctx.arc(14 + fontSize, 14 + boxH / 2, Math.max(3.5, fontSize * 0.34), 0, Math.PI * 2);
        ctx.fillStyle = Math.floor(t * 2) % 2 === 0 ? '#10b981' : '#34d399';
        ctx.fill();

        ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = '#e2e8f0';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `OPTICAL FEED 30.0 FPS · ${w}x${h} · TC 00:${mm}:${ss}:${ff}`,
          14 + fontSize * 1.9,
          14 + boxH / 2
        );
        ctx.restore();
      }
    },
    []
  );

  const startSimulatedCameraStream = useCallback(() => {
    cleanupStreams();
    const img = sceneImgRef.current;
    const w = img && img.naturalWidth > 0 ? img.naturalWidth : 1280;
    const h = img && img.naturalHeight > 0 ? img.naturalHeight : 720;

    const simCanvas = document.createElement('canvas');
    simCanvas.width = w;
    simCanvas.height = h;
    simCanvasRef.current = simCanvas;
    simPausedRef.current = false;

    const ctx = simCanvas.getContext('2d');
    if (ctx) {
      drawSimulatedFrame(ctx, w, h, performance.now(), true);
    }

    const renderLoop = (nowMs: number) => {
      if (ctx && !simPausedRef.current) {
        drawSimulatedFrame(ctx, simCanvas.width, simCanvas.height, nowMs, true);
      }
      simRafRef.current = requestAnimationFrame(renderLoop);
    };
    simRafRef.current = requestAnimationFrame(renderLoop);

    const capturedStream = simCanvas.captureStream(30);
    streamRef.current = capturedStream;
    setSourceDims({ w, h });
    setCameraMode('SIMULATED_30FPS');
    setCameraActive(true);
  }, [cleanupStreams, drawSimulatedFrame]);

  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch(() => {});
    }
  }, [cameraActive, cameraMode]);

  useEffect(() => {
    return () => {
      cleanupStreams();
    };
  }, [cleanupStreams]);

  const loadPresetImage = useCallback(
    (url: string = DEFAULT_BENCHMARK_SCENE, keepCameraIfSimulated: boolean = true) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        sceneImgRef.current = img;
        setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
        setUploadedImage(url);
        simPausedRef.current = false;
        if (simCanvasRef.current) {
          simCanvasRef.current.width = img.naturalWidth;
          simCanvasRef.current.height = img.naturalHeight;
        }
        if (!keepCameraIfSimulated || cameraMode === 'WEBCAM') {
          stopCamera();
        } else if (cameraActive && videoRef.current) {
          videoRef.current.play().catch(() => {});
        }
      };
      img.src = url;
    },
    [cameraActive, cameraMode, stopCamera]
  );

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      sceneImgRef.current = img;
      setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
      setUploadedImage(DEFAULT_BENCHMARK_SCENE);
    };
    img.src = DEFAULT_BENCHMARK_SCENE;
  }, []);

  const startCamera = useCallback(async () => {
    if (cameraActive) {
      stopCamera();
      return;
    }
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'environment' },
        });
        cleanupStreams();
        streamRef.current = stream;
        setCameraMode('WEBCAM');
        setCameraActive(true);
        return;
      }
    } catch {
      // No physical webcam attached or permission declined -> seamlessly activate 30fps live optical simulation
    }
    startSimulatedCameraStream();
  }, [cameraActive, stopCamera, cleanupStreams, startSimulatedCameraStream]);

  const resumeCameraFeed = useCallback(() => {
    simPausedRef.current = false;
    if (videoRef.current && cameraActive) {
      videoRef.current.play().catch(() => {});
    }
  }, [cameraActive]);

  const handleImageUpload = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    stopCamera();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        sceneImgRef.current = img;
        setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
        setUploadedImage(dataUrl);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const captureFrameBase64 = useCallback((): string | null => {
    try {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const drawSource = (source: CanvasImageSource, srcW: number, srcH: number) => {
        const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(srcW, srcH));
        canvas.width = Math.round(srcW * scale);
        canvas.height = Math.round(srcH * scale);
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
      };

      if (cameraActive && cameraMode === 'SIMULATED_30FPS' && simCanvasRef.current) {
        simPausedRef.current = true;
        const simCanvas = simCanvasRef.current;
        const simCtx = simCanvas.getContext('2d');
        if (simCtx) {
          // Render clean frame without top-left OSD text so video freeze-frame & AI crop match 1:1
          drawSimulatedFrame(simCtx, simCanvas.width, simCanvas.height, performance.now(), false);
        }
        return drawSource(simCanvas, simCanvas.width, simCanvas.height);
      }

      if (cameraActive && videoRef.current && videoRef.current.videoWidth > 0) {
        return drawSource(videoRef.current, videoRef.current.videoWidth, videoRef.current.videoHeight);
      }
      if (uploadedImage && sceneImgRef.current && sceneImgRef.current.complete) {
        return drawSource(sceneImgRef.current, sceneImgRef.current.naturalWidth, sceneImgRef.current.naturalHeight);
      }
    } catch (err) {
      console.warn('Frame capture skipped:', err);
    }
    return null;
  }, [cameraActive, cameraMode, uploadedImage, drawSimulatedFrame]);

  return {
    videoRef,
    canvasRef,
    sceneImgRef,
    uploadedImage,
    sourceDims,
    setSourceDims,
    cameraActive,
    cameraMode,
    startCamera,
    stopCamera,
    resumeCameraFeed,
    loadPresetImage,
    handleImageUpload,
    captureFrameBase64,
  };
}
