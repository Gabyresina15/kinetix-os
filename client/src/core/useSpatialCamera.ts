import { useState, useRef, useCallback, useEffect } from 'react';

const MAX_FRAME_SIDE = 960;
const DEFAULT_BENCHMARK_SCENE = '/hardware-bench1.jpg';

export function useSpatialCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneImgRef = useRef<HTMLImageElement | null>(null);

  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  const loadPresetImage = useCallback((url: string = DEFAULT_BENCHMARK_SCENE) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      sceneImgRef.current = img;
      setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
      setUploadedImage(url);
      setCameraActive(false);
    };
    img.src = url;
  }, []);

  useEffect(() => {
    loadPresetImage(DEFAULT_BENCHMARK_SCENE);
  }, [loadPresetImage]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'environment' },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setCameraActive(true);
        setUploadedImage(null);
      }
    } catch (err) {
      console.warn('Camera fallback active', err);
    }
  };

  const handleImageUpload = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () => {
        sceneImgRef.current = img;
        setSourceDims({ w: img.naturalWidth, h: img.naturalHeight });
        setUploadedImage(dataUrl);
        setCameraActive(false);
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
    startCamera,
    loadPresetImage,
    handleImageUpload,
    captureFrameBase64,
  };
}
