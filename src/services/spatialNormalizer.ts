export interface RawSamMask {
  id: string;
  // Coordenadas normalizadas de 0 a 1: [xMin, yMin, width, height]
  bbox: [number, number, number, number];
  confidence: number;
  svgPath: string; // Polígono SVG que vamos a dibujar arriba del video
  cropBase64: string;
  detectedClassHint?: string;
}

export interface NormalizedSpatialObject extends RawSamMask {
  centroid: [number, number];
  zone: 'LEFT' | 'CENTER' | 'RIGHT' | 'BOTTOM_PII';
  isSensitivePII: boolean;
}

/**
 * Convierte píxeles/máscaras crudas de SAM 3.1 en zonas semánticas determinísticas
 * para que Muse Spark no tenga que adivinar geometría.
 */
export function normalizeSpatialScene(rawMasks: RawSamMask[]): NormalizedSpatialObject[] {
  return rawMasks.map((mask) => {
    const [x, y, w, h] = mask.bbox;
    const cx = Number((x + w / 2).toFixed(3));
    const cy = Number((y + h / 2).toFixed(3));

    // Regla 1: Si está en el tercio inferior y tiene proporción de tarjeta/documento/rostro, es PII
    const isBottomCorner = cy > 0.72;
    const isSensitivePII =
      isBottomCorner ||
      mask.detectedClassHint === 'id_card' ||
      mask.detectedClassHint === 'face';

    let zone: NormalizedSpatialObject['zone'] = 'CENTER';
    if (isSensitivePII) {
      zone = 'BOTTOM_PII';
    } else if (cx < 0.36) {
      zone = 'LEFT';
    } else if (cx > 0.64) {
      zone = 'RIGHT';
    } else {
      zone = 'CENTER';
    }

    return {
      ...mask,
      centroid: [cx, cy],
      zone,
      isSensitivePII,
    };
  });
}
