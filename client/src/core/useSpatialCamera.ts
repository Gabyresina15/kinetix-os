import { useState, useRef, useCallback, useEffect } from 'react';

const MAX_FRAME_SIDE = 1920;
const DEFAULT_BENCHMARK_SCENE = '/hardware-bench1.jpg';

export type CameraFeedMode = 'OFF' | 'WEBCAM';

export function useSpatialCamera(onCameraNotice?: (msg: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneImgRef = useRef<HTMLImageElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [uploadedImage, setUploadedImage] = useState<string | null>(DEFAULT_BENCHMARK_SCENE);
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraFeedMode>('OFF');

  const cleanupStreams = useCallback(() => {
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

  useEffect(() => {
    if (cameraActive && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch(() => {});
    }
  }, [cameraActive]);

  useEffect(() => {
    return () => {
      cleanupStreams();
    };
  }, [cleanupStreams]);

  const loadPresetImage = useCallback(
    (url: string = DEFAULT_BENCHMARK_SCENE) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        sceneImgRef.current = img;
        setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
        setUploadedImage(url);
        stopCamera();
      };
      img.src = url;
    },
    [stopCamera]
  );

  useEffect(() => {
    loadPresetImage(DEFAULT_BENCHMARK_SCENE);
  }, [loadPresetImage]);

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
        setUploadedImage(null);
        return;
      }
    } catch {
      // No physical webcam attached
    }
    onCameraNotice?.('No physical USB webcam detected — using high-res Workbench Feed');
  }, [cameraActive, stopCamera, cleanupStreams, onCameraNotice]);

  const resumeCameraFeed = useCallback(() => {
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
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.96);
      };

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
  }, [cameraActive, uploadedImage]);

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
