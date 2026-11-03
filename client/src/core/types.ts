// --- 1. MÁQUINA DE ESTADOS FINITA (FSM) Y ESTADOS DEL DAG ---
export type OrchestrationPhase =
  | 'LIVE_IDLE'
  | 'SCANNING_SCENE'
  | 'EXECUTING_DAG'
  | 'FRAME_LOCKED'
  | 'ABORTED'
  | 'FAULT';

export type DagNodeId =
  | 'sam_lock'
  | 'spark_plan'
  | 'quarantine_and_claim'
  | 'mutate_inventory'
  | 'generate_studio_catalog'
  | 'recalculate_margins_vm';

export type DagNodeStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'MUTATED'
  | 'HELD_GUARDRAIL'
  | 'FAILED'
  | 'ABORTED'
  | 'SKIPPED';

export type MaskStatus =
  | 'IDLE_OBSERVED'
  | 'QUARANTINED'
  | 'STOCK_MUTATED'
  | 'CATALOG_SYNTH'
  | 'PII_REDACTED';

export interface ExecutionStep {
  id: string;
  title: string;
  model: string;
  status: DagNodeStatus;
  detail?: string;
  latencyMs?: number;
}

export interface TelemetryState {
  samMs: number;
  sparkMs: number;
  sparkFirstTokenMs?: number;
  voiceMs?: number;
  segmenter: string;
  piiRedacted: number;
}

// --- 2. CONTRATO ESPACIAL Y ENTIDADES ERP ---
export interface SpatialMask {
  id: string;
  label: string;
  bbox: [number, number, number, number]; // [xMin, yMin, width, height] en rango [0..1]
  centroid?: [number, number];
  spatialRegion2D?: string;
  assignedActionStatus: MaskStatus;
  isSensitivePII: boolean;
  confidence: number;
  cropBase64?: string;
}

export interface InventoryItem {
  sku: string;
  name: string;
  stock: number;
  standardInboundLot?: number;
  baseCostUsd: number;
  sellPriceUsd: number;
  _highlightDelta?: string;
  _repriced?: boolean;
}

export interface SupplierClaim {
  id: string;
  mongoId?: string;
  maskId: string;
  matchedSku?: string;
  objectLabel: string;
  reason: string;
  baseCostUsd?: number;
  damageFactor?: number;
  defectSeverity?: 'INTACT' | 'MINOR' | 'MODERATE' | 'CRITICAL';
  amountUsd: number;
  thresholdUsd: number;
  cropBase64?: string;
  guardrailStatus: 'HELD_WAITING_VOICE_AUTH' | 'AUTHORIZED_AND_DISPATCHED' | 'AUTO_APPROVED';
  dispatchChannel?: string;
  externalReceiptId?: string;
  timestamp: string;
}

export interface VisualDna {
  containerGeometry: string;
  exactColorPalette: string;
  detectedBrandOrText: string;
  surfaceMaterial: string;
}

export interface StudioCatalogResult {
  id: string;
  mongoId?: string;
  maskId: string;
  title: string;
  visualDna: VisualDna;
  promptUsed: string;
  sourceCropUrl: string;
  studioImageUrl: string;
  usedLiveApi: boolean;
  resolution?: string;
  synthesisLatencyMs: number;
}

export interface VmExecutionResult {
  finalPrice: number;
  executedCode: string;
  usedFallback: boolean;
  sandboxEngine?: string;
  invariantsPassed?: boolean;
  policyModelUsed?: string;
  updatedSku: string;
  targetMarginPercent: number;
  taxRatePercent: number;
}

export interface InventoryMutationResult extends InventoryItem {
  previousStock: number;
  delta: number;
  mongoId: string;
  maskId: string;
}

export type AuditTxType =
  | 'STOCK_DELTA'
  | 'WASM_REPRICE'
  | 'SUPPLIER_CLAIM'
  | 'GUARDRAIL_AUTHORIZED'
  | 'STUDIO_SYNTH'
  | 'SUPERVISOR_TRIAGE'
  | 'COMPENSATING_UNDO';

export interface AuditLedgerBlock {
  index: number;
  txId: string;
  timestamp: string;
  type: AuditTxType;
  skuOrRef: string;
  summary: string;
  prevHash: string;
  txHash: string;
  reversible: boolean;
  rolledBack: boolean;
}

export interface AuditChainIntegrity {
  valid: boolean;
  blockCount: number;
  headHash: string;
}

// --- 3. UNIÓN DISCRIMINADA DE HERRAMIENTAS Y STREAM SSE ---
export type ToolMutationPayload =
  | { tool: 'quarantine_and_claim'; targetMaskId: string; dagStage?: number; status: DagNodeStatus; latencyMs: number; result: SupplierClaim }
  | { tool: 'mutate_inventory'; targetMaskId: string; dagStage?: number; status: DagNodeStatus; latencyMs: number; result: InventoryMutationResult }
  | { tool: 'generate_studio_catalog'; targetMaskId: string; dagStage?: number; status: DagNodeStatus; latencyMs: number; result: StudioCatalogResult }
  | { tool: 'recalculate_margins_vm'; targetMaskId?: string; dagStage?: number; status: DagNodeStatus; latencyMs: number; result: VmExecutionResult };

export type KinetixSseEvent =
  | { event: 'VISION_SCAN_STARTED'; data: { model: string; timestamp: number } }
  | {
      event: 'SPATIAL_LOCK';
      data: {
        model: string;
        latencyMs: number;
        sparkLatencyMs: number;
        sparkFirstTokenMs?: number;
        samUsed: boolean;
        samLatencyMs: number;
        samRefined: number;
        piiRedacted?: number;
        objects: SpatialMask[];
      };
    }
  | { event: 'SPARK_REASONING_DELTA'; data: { model: string; elapsedMs: number; snippet: string } }
  | { event: 'SPARK_REASONING_TRACE'; data: { model: string; reasoning: string } }
  | { event: 'SPARK_PLAN_LOCKED'; data: { model: string; latencyMs: number; firstTokenLatencyMs?: number; plan: { summary: string; requestedTools: DagNodeId[] } } }
  | { event: 'TOOL_MUTATED'; data: ToolMutationPayload }
  | { event: 'TOOL_FAILED'; data: { tool: DagNodeId; targetMaskId?: string; dagStage?: number; error: string; latencyMs: number } }
  | { event: 'ORCHESTRATION_COMPLETE'; data: { totalElapsedMs: number; storeState: { inventory: InventoryItem[] } } }
  | { event: 'ORCHESTRATION_ERROR'; data: { message: string } };
