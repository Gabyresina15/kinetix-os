export interface RawSamMask {
  id: string;
  label: string;
  bbox: [number, number, number, number];
  confidence: number;
  cropBase64: string;
  isSensitivePII?: boolean;
}

export interface NormalizedSpatialObject extends RawSamMask {
  centroid: [number, number];
  spatialRegion2D: string;
  assignedActionStatus?: 'IDLE_OBSERVED' | 'QUARANTINED' | 'STOCK_MUTATED' | 'CATALOG_SYNTH' | 'PII_REDACTED';
}

export function normalizeSpatialScene(rawMasks: RawSamMask[]): NormalizedSpatialObject[] {
  return rawMasks.map((mask) => {
    const [x, y, w, h] = mask.bbox;
    const cx = Number((x + w / 2).toFixed(3));
    const cy = Number((y + h / 2).toFixed(3));

    const horiz = cx < 0.34 ? 'LEFT' : cx > 0.66 ? 'RIGHT' : 'CENTER';
    const depth = cy < 0.42 ? 'BACK' : cy > 0.68 ? 'FRONT' : 'MID';
    const spatialRegion2D = `${depth}_${horiz}`;

    return {
      ...mask,
      centroid: [cx, cy],
      spatialRegion2D,
      isSensitivePII: Boolean(mask.isSensitivePII),
      assignedActionStatus: mask.isSensitivePII ? 'PII_REDACTED' : 'IDLE_OBSERVED',
    };
  });
}