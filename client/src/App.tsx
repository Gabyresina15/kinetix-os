import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Camera,
  Mic,
  RotateCcw,
  Upload,
  XCircle,
  Zap,
  Sparkles,
  Package,
  Terminal,
  Play,
  AlertTriangle,
  Scan,
  CheckCircle2,
  Download,
  Lock,
  Loader2,
} from 'lucide-react';

import {
  SpatialMask,
  InventoryItem,
  ExecutionStep,
  TelemetryState,
  SupplierClaim,
  StudioCatalogResult,
  VmExecutionResult,
  MaskStatus,
  AuditLedgerBlock,
  AuditChainIntegrity,
} from './core/types';
import { useSpatialCamera } from './core/useSpatialCamera';
import { useKinetixStream } from './core/useKinetixStream';
import { useDominoQueue } from './core/useDominoQueue';
import { useMuseVoiceRecorder } from './core/useMuseVoiceRecorder';
import { TelemetryHud } from './components/TelemetryHud';
import { ReasoningTerminal } from './components/ReasoningTerminal';
import { AgentDagPanel } from './components/AgentDagPanel';
import { AuditLedgerDrawer } from './components/AuditLedgerDrawer';
import { apiUrl, apiHeaders } from './core/apiConfig';

const MASK_STYLE_MAP: Record<string, string> = {
  IDLE_OBSERVED: 'border-slate-500/60 bg-slate-500/10 text-slate-300',
  IDLE: 'border-slate-500/60 bg-slate-500/10 text-slate-300',
  QUARANTINED: 'border-rose-500 bg-rose-500/15 text-rose-100 shadow-[0_0_12px_rgba(244,63,94,0.6)]',
  STOCK_MUTATED: 'border-emerald-400 bg-emerald-400/12 text-emerald-100 shadow-[0_0_12px_rgba(52,211,153,0.6)]',
  CATALOG_SYNTH: 'border-cyan-400 bg-cyan-400/14 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.6)]',
  STUDIO_SYNTHESIZED: 'border-cyan-400 bg-cyan-400/14 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.6)]',
  PII_REDACTED: 'border-amber-400 bg-amber-400/20 text-amber-100',
};

const resolveMaskStyle = (status: MaskStatus | undefined): string =>
  MASK_STYLE_MAP[status ?? 'IDLE_OBSERVED'] || MASK_STYLE_MAP.IDLE_OBSERVED;

const DEFAULT_PROMPT =
  'The copper-heatpipe tower cooler arrived with a crushed heatsink fin, open a supplier claim. Add the two DDR5 RAM modules and the M.2 NVMe SSD to stock, generate a 512x512 studio catalog photo for the modular power supply, and recalculate prices with a 32% margin.';

const BENCH_2_PROMPT =
  'Add the dual-fan graphics card, the Mini-ITX motherboard, and the AMD processor box to inventory stock, generate a 512x512 studio catalog photo for the graphics card, and recalculate prices with a 30% gross margin.';

const INITIAL_STEPS: ExecutionStep[] = [
  { id: 'sam_lock', title: '2D Spatial Grounding & IoU Box Refinement', model: 'SAM 3.1 IoU + Sharp Cropper', status: 'PENDING' },
  { id: 'spark_plan', title: 'Multi-Tool Spatial Plan (Streaming)', model: 'meta-models/muse-spark-open-1026 (Baseten)', status: 'PENDING' },
  { id: 'quarantine_and_claim', title: 'Stage 1: Quarantine & Dynamic Claim', model: 'Catalog BaseCost × DamageFactor', status: 'PENDING' },
  { id: 'mutate_inventory', title: 'Stage 1: Inventory SKU Auto-Upsert', model: 'Action Engine', status: 'PENDING' },
  { id: 'generate_studio_catalog', title: 'Stage 1: 512x512 Studio Catalog Synthesis', model: 'Muse Image 1.0 (512x512)', status: 'PENDING' },
  { id: 'recalculate_margins_vm', title: 'Stage 2: Dynamic Policy Synth & 50ms Sandbox', model: 'Muse Code / Wonder + 50ms Sandbox', status: 'PENDING' },
];

export default function App() {
  const {
    videoRef,
    canvasRef,
    uploadedImage,
    sourceDims,
    cameraActive,
    startCamera,
    loadPresetImage,
    handleImageUpload,
    captureFrameBase64,
  } = useSpatialCamera();

  const { runStream, abortStream } = useKinetixStream();
  const { enqueue, clearQueue } = useDominoQueue(180);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  const [phase, setPhase] = useState<'LIVE_IDLE' | 'SCANNING_SCENE' | 'EXECUTING_DAG' | 'FRAME_LOCKED' | 'ABORTED'>('LIVE_IDLE');
  const [flashEffect, setFlashEffect] = useState(false);
  const [voiceBanner, setVoiceBanner] = useState<string | null>(null);

  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [backendModeBadge, setBackendModeBadge] = useState<'LIVE · BASETEN' | 'REPLAY · FIXTURE'>('LIVE · BASETEN');
  const [auditBlocks, setAuditBlocks] = useState<AuditLedgerBlock[]>([]);
  const [auditIntegrity, setAuditIntegrity] = useState<AuditChainIntegrity>({
    valid: true,
    blockCount: 0,
    headHash: '0000000000000000000000000000000000000000000000000000000000000000',
  });
  const [undoingTxId, setUndoingTxId] = useState<string | null>(null);

  const isBusy = phase === 'SCANNING_SCENE' || phase === 'EXECUTING_DAG';

  const [masks, setMasks] = useState<SpatialMask[]>([]);
  const [activePulse, setActivePulse] = useState<{ id: string; actionText: string } | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);

  const speakTactical = useCallback((msg: string) => {
    if (!ttsEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(msg);
    u.lang = 'en-US';
    u.rate = 1.08;
    u.pitch = 0.92;
    window.speechSynthesis.speak(u);
  }, [ttsEnabled]);

  const [telemetry, setTelemetry] = useState<TelemetryState>({
    samMs: 0,
    sparkMs: 0,
    voiceMs: 0,
    segmenter: 'Sharp crop',
    piiRedacted: 0,
  });

  const [steps, setSteps] = useState<ExecutionStep[]>(INITIAL_STEPS);
  const [inventory, setInventory] = useState<InventoryItem[]>([
    { sku: 'LOADING', name: 'Syncing live ledger with Kinetix Backend...', stock: 0, baseCostUsd: 0, sellPriceUsd: 0 },
  ]);
  const [latestClaim, setLatestClaim] = useState<SupplierClaim | null>(null);
  const [latestCatalog, setLatestCatalog] = useState<StudioCatalogResult | null>(null);
  const [vmExecution, setVmExecution] = useState<VmExecutionResult | null>(null);
  const [voiceText, setVoiceText] = useState(DEFAULT_PROMPT);
  const [reasoningTrace, setReasoningTrace] = useState('');
  const [triageSkuChoice, setTriageSkuChoice] = useState<string>('');
  const [triageCustomMode, setTriageCustomMode] = useState<boolean>(false);
  const [triageNewSku, setTriageNewSku] = useState<string>('');
  const [triageNewName, setTriageNewName] = useState<string>('');
  const [triageNewCost, setTriageNewCost] = useState<string>('95');

  const { voiceStatus, toggleRecording, cancelRecording } = useMuseVoiceRecorder(
    ({ transcript, latencyMs, modelUsed, biasedKeywordsCount }) => {
      setVoiceText(transcript);
      setTelemetry((prev) => ({ ...prev, voiceMs: latencyMs }));
      setVoiceBanner(
        `${modelUsed} · ${latencyMs}ms${biasedKeywordsCount ? ` · ${biasedKeywordsCount} SKU bias terms` : ''}`
      );
    },
    (errMsg) => {
      setVoiceBanner(`Voice ASR Notice: ${errMsg}`);
    }
  );

  const fetchAuditLedger = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/audit-ledger'), { headers: apiHeaders() });
      const data = await res.json();
      if (data.ok) {
        if (Array.isArray(data.blocks)) setAuditBlocks(data.blocks);
        if (data.integrity) setAuditIntegrity(data.integrity);
      }
    } catch (err) {
      console.error('Failed to sync SHA-256 audit ledger', err);
    }
  }, []);

  const handleUndoTx = useCallback(async (txId: string) => {
    setUndoingTxId(txId);
    try {
      const res = await fetch(apiUrl('/api/audit-ledger/undo'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ txId }),
      });
      const data = await res.json();
      if (data.ok) {
        if (Array.isArray(data.inventory)) setInventory(data.inventory);
        if (Array.isArray(data.claims)) {
          setLatestClaim(data.claims.length > 0 ? data.claims[0] : null);
        }
        if (Array.isArray(data.blocks)) setAuditBlocks(data.blocks);
        if (data.integrity) setAuditIntegrity(data.integrity);
        speakTactical('Compensating transaction committed to SHA-256 ledger.');
      }
    } catch (err) {
      console.error('Compensating undo failed', err);
    } finally {
      setUndoingTxId(null);
    }
  }, [speakTactical]);

  const fetchLiveLedger = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/live-ledger'), { headers: apiHeaders() });
      const data = await res.json();
      if (data.ok && Array.isArray(data.inventory)) {
        setInventory(data.inventory);
      }
    } catch (err) {
      console.error('Failed to sync live ledger', err);
    }
  }, []);

  useEffect(() => {
    fetchLiveLedger();
    fetchAuditLedger();
    fetch(apiUrl('/api/health'), { headers: apiHeaders() })
      .then((r) => r.json())
      .then((h) => {
        if (h && (h.mode === 'REPLAY' || (!h.basetenConfigured && !h.metaApiConfigured))) {
          setBackendModeBadge('REPLAY · FIXTURE');
        } else {
          setBackendModeBadge('LIVE · BASETEN');
        }
      })
      .catch(() => {});
  }, [fetchLiveLedger, fetchAuditLedger]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const stageBox = (() => {
    if (!sourceDims || !stageSize.w || !stageSize.h) return null;
    const scale = Math.min(stageSize.w / sourceDims.w, stageSize.h / sourceDims.h);
    return { w: sourceDims.w * scale, h: sourceDims.h * scale };
  })();

  const updateStep = useCallback((id: string, patch: Partial<ExecutionStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const getMaskStatusForTool = (tool: string): MaskStatus => {
    switch (tool) {
      case 'quarantine_and_claim': return 'QUARANTINED';
      case 'mutate_inventory': return 'STOCK_MUTATED';
      case 'generate_studio_catalog': return 'CATALOG_SYNTH';
      default: return 'IDLE_OBSERVED';
    }
  };

  const getPulseActionText = (tool: string): string => {
    switch (tool) {
      case 'quarantine_and_claim': return 'QUARANTINED';
      case 'mutate_inventory': return '+ STOCK';
      case 'generate_studio_catalog': return 'STUDIO SYNTH';
      case 'recalculate_margins_vm': return 'REPRICED';
      default: return 'UPDATED';
    }
  };

  const triggerOrchestration = useCallback(async () => {
    if (phase === 'EXECUTING_DAG' || phase === 'SCANNING_SCENE') return;

    abortStream();

    setPhase('SCANNING_SCENE');
    setFlashEffect(true);
    setTimeout(() => setFlashEffect(false), 150);

    const frameBase64 = captureFrameBase64();
    if (videoRef.current && cameraActive) {
      videoRef.current.pause();
    }

    clearQueue();
    setMasks([]);
    setReasoningTrace('');
    setLatestClaim(null);
    setLatestCatalog(null);
    setVmExecution(null);
    setTelemetry((prev) => ({
      samMs: 0,
      sparkMs: 0,
      voiceMs: prev.voiceMs,
      segmenter: 'Sharp crop',
      piiRedacted: 0,
    }));
    setSteps(
      INITIAL_STEPS.map((s, idx) => ({
        ...s,
        status: idx === 0 ? 'RUNNING' : 'PENDING',
        detail: idx === 0 ? 'Scanning scene & planning multimodal DAG...' : undefined,
      }))
    );
    await fetchLiveLedger();

    await runStream(
      frameBase64,
      voiceText,
      (eventObj) => {
        const { event, data } = eventObj;

        if (event === 'VISION_SCAN_STARTED') {
          enqueue(() => {
            updateStep('sam_lock', { status: 'RUNNING', detail: 'Muse Spark Open is grounding scene objects' });
          });
        }

        if (event === 'SPATIAL_LOCK') {
          const incomingObjects = Array.isArray(data.objects) ? data.objects : [];
          const redactedCount =
            typeof data.piiRedacted === 'number'
              ? data.piiRedacted
              : incomingObjects.filter((o) => o.isSensitivePII).length;
          enqueue(() => {
            setMasks(incomingObjects);
            setTelemetry((t) => ({
              ...t,
              samMs: data.samUsed ? data.samLatencyMs! : data.latencyMs || t.samMs,
              sparkMs: data.sparkLatencyMs || t.sparkMs,
              sparkFirstTokenMs: data.sparkFirstTokenMs,
              segmenter: data.samUsed ? 'SAM 3.1 IoU' : 'Sharp crop',
              piiRedacted: redactedCount,
            }));
            updateStep('sam_lock', {
              status: 'MUTATED',
              model: data.samUsed ? 'SAM 3.1 (IoU Box Refinement)' : 'Muse Spark Vision + Sharp Cropper',
              latencyMs: data.samUsed ? data.samLatencyMs : data.latencyMs,
              detail: data.samUsed
                ? `SAM 3.1 refined ${data.samRefined} bounding boxes via IoU`
                : `${incomingObjects.length} actionable objects cropped (${redactedCount} PII shields)`,
            });
            updateStep('spark_plan', { status: 'RUNNING' });
            setPhase('EXECUTING_DAG');
          });
        }

        if (event === 'SPARK_REASONING_DELTA') {
          if (data.snippet) {
            setReasoningTrace(data.snippet);
            updateStep('spark_plan', {
              status: 'RUNNING',
              latencyMs: data.elapsedMs,
              detail: 'Streaming multimodal spatial reasoning from Baseten...',
            });
          }
        }

        if (event === 'SPARK_REASONING_TRACE') {
          setReasoningTrace(data.reasoning || '');
        }

        if (event === 'SPARK_PLAN_LOCKED') {
          const plannedTools = new Set<string>(
            Array.isArray((data.plan as any)?.actions)
              ? (data.plan as any).actions.map((a: any) => String(a.tool))
              : []
          );
          enqueue(() => {
            setTelemetry((t) => ({ ...t, sparkMs: data.latencyMs || t.sparkMs }));
            updateStep('spark_plan', {
              status: 'MUTATED',
              latencyMs: data.latencyMs,
              detail: data.plan?.summary || 'Spatial plan locked',
            });

            ['quarantine_and_claim', 'mutate_inventory', 'generate_studio_catalog', 'recalculate_margins_vm'].forEach(
              (id) =>
                updateStep(
                  id,
                  plannedTools.size === 0 || plannedTools.has(id)
                    ? { status: 'RUNNING', detail: 'Executing in concurrent stage...' }
                    : { status: 'SKIPPED', detail: 'Not requested by operator command' }
                )
            );
          });
        }

        if (event === 'TOOL_FAILED') {
          const { tool, error, latencyMs } = data;
          enqueue(() => {
            updateStep(tool, {
              status: 'FAILED',
              latencyMs,
              detail: error || 'Tool execution failed',
            });
          });
        }

        if (event === 'TOOL_MUTATED') {
          const { tool, targetMaskId, latencyMs, result } = data;
          const resolvedMaskId = targetMaskId || (result as any)?.maskId;

          enqueue(() => {
            if (resolvedMaskId) {
              setMasks((prev) =>
                prev.map((m) =>
                  m.id === resolvedMaskId ? { ...m, assignedActionStatus: getMaskStatusForTool(tool) } : m
                )
              );
              setActivePulse({ id: resolvedMaskId, actionText: getPulseActionText(tool) });
              setTimeout(() => setActivePulse(null), 350);
            }

            if (tool === 'quarantine_and_claim' && result) {
              const claimResult = result as SupplierClaim;
              setLatestClaim(claimResult);
              const held = claimResult.guardrailStatus === 'HELD_WAITING_VOICE_AUTH';
              updateStep(tool, {
                status: 'MUTATED',
                latencyMs,
                detail: held
                  ? `Claim #${claimResult.id} (-$${Number(claimResult.amountUsd).toFixed(2)}) held by $50 guardrail`
                  : `Claim #${claimResult.id} (-$${Number(claimResult.amountUsd).toFixed(2)}) auto-approved`,
              });
            }

            if (tool === 'mutate_inventory' && result) {
              const invResult = result as any;
              setInventory((prev) => {
                const existing = prev.find((item) => item.sku === invResult.sku);
                const updatedItem: InventoryItem = existing
                  ? {
                      ...existing,
                      name: invResult.name || existing.name,
                      stock: invResult.stock,
                      sellPriceUsd: invResult.sellPriceUsd ?? existing.sellPriceUsd,
                      _highlightDelta: `+${invResult.delta ?? 1}`,
                    }
                  : {
                      sku: invResult.sku,
                      name: invResult.name || 'Component',
                      stock: invResult.stock ?? 1,
                      baseCostUsd: invResult.baseCostUsd ?? 90.0,
                      sellPriceUsd: invResult.sellPriceUsd ?? 149.0,
                      _highlightDelta: `+${invResult.delta ?? 1}`,
                    };
                return [updatedItem, ...prev.filter((item) => item.sku !== invResult.sku)];
              });
              const mutationLine = `${invResult.sku}: ${invResult.previousStock ?? '?'}→${invResult.stock} (+${invResult.delta ?? 1})`;
              setSteps((prev) =>
                prev.map((s) =>
                  s.id === tool
                    ? {
                        ...s,
                        status: 'MUTATED',
                        latencyMs,
                        detail:
                          s.detail &&
                          !s.detail.startsWith('Executing') &&
                          !s.detail.includes(invResult.sku)
                            ? `${s.detail} · ${mutationLine}`
                            : mutationLine,
                      }
                    : s
                )
              );
            }

            if (tool === 'generate_studio_catalog' && result) {
              const catResult = result as StudioCatalogResult;
              setLatestCatalog(catResult);
              updateStep(tool, {
                status: 'MUTATED',
                latencyMs: catResult.synthesisLatencyMs || latencyMs,
                detail: `Published "${catResult.title}" (${catResult.resolution || '512x512'})`,
              });
            }

            if (tool === 'recalculate_margins_vm' && result) {
              const vmResult = result as VmExecutionResult & {
                cleanCodeShownInUI?: string;
                repricedSkus?: Array<{ sku: string; finalPrice: number }>;
              };
              const normalizedVm: VmExecutionResult = {
                ...vmResult,
                executedCode: vmResult.executedCode || vmResult.cleanCodeShownInUI || '',
              };
              setVmExecution(normalizedVm);
              const batch =
                Array.isArray(vmResult.repricedSkus) && vmResult.repricedSkus.length > 0
                  ? vmResult.repricedSkus
                  : [{ sku: vmResult.updatedSku || 'SKU-DDR5-32GB-KIT', finalPrice: vmResult.finalPrice }];
              const priceBySku = new Map(batch.map((b) => [b.sku, b.finalPrice]));
              setInventory((prev) =>
                prev.map((item) =>
                  priceBySku.has(item.sku)
                    ? { ...item, sellPriceUsd: priceBySku.get(item.sku)!, _repriced: true }
                    : item
                )
              );
              const detailText =
                batch.length > 1
                  ? `Repriced ${batch.length} SKUs (${batch.map((b) => `${b.sku}→$${b.finalPrice}`).join(', ')})`
                  : `${batch[0].sku} repriced to $${batch[0].finalPrice} USD`;
              updateStep(tool, {
                status: 'MUTATED',
                latencyMs,
                model: normalizedVm.policyModelUsed || 'Muse Code / Wonder + 50ms Sandbox',
                detail: detailText,
              });
            }
          });
        }

        if (event === 'ORCHESTRATION_ERROR') {
          enqueue(() => {
            setPhase('FAULT' as any);
            setSteps((prev) =>
              prev.map((s) => (s.status === 'RUNNING' ? { ...s, status: 'FAILED', detail: data.message } : s))
            );
          });
        }

        if (event === 'ORCHESTRATION_COMPLETE') {
          enqueue(() => {
            setPhase('FRAME_LOCKED');
            setSteps((prev) =>
              prev.map((s) =>
                s.status === 'RUNNING' ? { ...s, status: 'SKIPPED', detail: 'Not executed in this plan' } : s
              )
            );
            speakTactical('Spatial lock complete. Actionable assets indexed.');

            if (data.storeState && Array.isArray(data.storeState.inventory)) {
              setInventory((prev) => {
                const badgesBySku = new Map(
                  prev.map((it) => [it.sku, { _highlightDelta: it._highlightDelta, _repriced: it._repriced }])
                );
                const merged = data.storeState.inventory.map((it: InventoryItem) => ({
                  ...it,
                  ...badgesBySku.get(it.sku),
                }));
                return [
                  ...merged.filter((it: InventoryItem) => it._highlightDelta || it._repriced),
                  ...merged.filter((it: InventoryItem) => !it._highlightDelta && !it._repriced),
                ];
              });
            }
            void fetchAuditLedger();
          });
        }
      },
      (err) => {
        console.error('SSE Stream Error:', err);
        enqueue(() => {
          setPhase('ABORTED');
        });
      }
    );
  }, [
    phase,
    cameraActive,
    uploadedImage,
    voiceText,
    captureFrameBase64,
    clearQueue,
    enqueue,
    speakTactical,
    runStream,
    updateStep,
    fetchLiveLedger,
    fetchAuditLedger,
  ]);

  const abortRun = useCallback(() => {
    abortStream();
    clearQueue();
    setPhase('ABORTED');
    setActivePulse(null);
    setSteps((prev) =>
      prev.map((s) =>
        s.status === 'RUNNING' || s.status === 'PENDING'
          ? { ...s, status: 'FAILED', detail: 'Aborted by operator' }
          : s
      )
    );
  }, [abortStream, clearQueue]);

  const authorizeGuardrailClaim = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/confirm-guardrail'), {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ claimId: latestClaim?.id }),
      });
      const data = await res.json();
      if (data.ok && data.claim) {
        setLatestClaim(data.claim);
        updateStep('quarantine_and_claim', {
          detail: `Claim #${data.claim.id} AUTHORIZED (${data.claim.dispatchChannel})`,
        });
        void fetchAuditLedger();
        speakTactical(
          data.deliveredExternally
            ? 'Supplier claim authorized and dispatched to Telegram.'
            : 'Supplier claim authorized and recorded in local ledger.'
        );
      }
    } catch (err) {
      console.error('Guardrail confirm failed', err);
    }
  }, [latestClaim?.id, speakTactical, updateStep, fetchAuditLedger]);

  const switchBenchScene = useCallback(
    (benchUrl: '/hardware-bench1.jpg' | '/hardware-bench.jpg') => {
      loadPresetImage(benchUrl);
      setSelectedMaskId(null);
      setMasks([]);
      setReasoningTrace('');
      setLatestClaim(null);
      setLatestCatalog(null);
      setVmExecution(null);
      setPhase('LIVE_IDLE');
      setActivePulse(null);
      clearQueue();
      abortStream();
      setSteps(INITIAL_STEPS);
      setVoiceText(benchUrl === '/hardware-bench.jpg' ? BENCH_2_PROMPT : DEFAULT_PROMPT);
    },
    [loadPresetImage, clearQueue, abortStream]
  );

  const resetDemoState = useCallback(async () => {
    try {
      await fetch(apiUrl('/api/reset-demo'), { method: 'POST', headers: apiHeaders() });
    } catch {}
    cancelRecording();
    loadPresetImage('/hardware-bench1.jpg');
    setSelectedMaskId(null);
    setVoiceBanner(null);
    setMasks([]);
    setReasoningTrace('');
    setLatestClaim(null);
    setLatestCatalog(null);
    setVmExecution(null);
    setPhase('LIVE_IDLE');
    setActivePulse(null);
    clearQueue();
    abortStream();
    setVoiceText(DEFAULT_PROMPT);
    setTelemetry({ samMs: 0, sparkMs: 0, voiceMs: 0, segmenter: 'Sharp crop', piiRedacted: 0 });
    setSteps(INITIAL_STEPS);
    await Promise.all([fetchLiveLedger(), fetchAuditLedger()]);
    if (videoRef.current && cameraActive) videoRef.current.play();
  }, [cameraActive, clearQueue, abortStream, cancelRecording, loadPresetImage, fetchLiveLedger, fetchAuditLedger]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (voiceText.trim().length > 0) {
          triggerOrchestration();
        }
      }
      if (e.code === 'KeyC') {
        e.preventDefault();
        authorizeGuardrailClaim();
      }
      if (e.code === 'KeyR') {
        e.preventDefault();
        resetDemoState();
      }
      if (e.code === 'KeyL') {
        e.preventDefault();
        setLedgerOpen((prev) => !prev);
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        if (ledgerOpen) {
          setLedgerOpen(false);
        } else {
          abortRun();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [triggerOrchestration, authorizeGuardrailClaim, resetDemoState, phase, abortRun, voiceText, ledgerOpen]);

  const renderMask = (m: SpatialMask) => {
    const [x, y, w, h] = m.bbox;
    const isApproximate = m.confidence === undefined || m.confidence < 0.1;
    const isActive = activePulse?.id === m.id;
    const isSelected = m.id === selectedMaskId;

    const statusStyle = isApproximate
      ? 'border-amber-500/80 bg-amber-500/10 border-dashed text-amber-400'
      : resolveMaskStyle(m.assignedActionStatus);
    const opacity = isActive ? 1 : isApproximate ? 0.75 : m.confidence ? Math.max(0.55, m.confidence) : 1;

    const selectMaskForTriage = () => {
      if (m.id === selectedMaskId) {
        setSelectedMaskId(null);
        return;
      }
      setSelectedMaskId(m.id);
      setTriageCustomMode(false);
      setTriageSkuChoice('');
      const cleanLbl = (m.label || m.id).replace(/\s*\[PENDING.*?\]/i, '').trim();
      setTriageNewSku(
        `SKU-${cleanLbl.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'CUSTOM'}`
      );
      setTriageNewName(cleanLbl);
      setTriageNewCost('95');
    };

    return (
      <div
        key={m.id}
        onClick={selectMaskForTriage}
        className={`absolute border-2 rounded-sm pointer-events-auto cursor-pointer transition-all duration-300 ${statusStyle} ${
          isActive
            ? 'scale-[1.03] z-50 bg-white/25 border-white shadow-[0_0_30px_rgba(255,255,255,0.85)]'
            : isSelected
            ? 'border-amber-400 bg-amber-500/20 z-40 shadow-[0_0_20px_rgba(245,158,11,0.5)]'
            : ''
        }`}
        style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%`, opacity }}
      >
        <div className="absolute top-0 left-0 w-2 h-2 border-t-2 border-l-2 border-current" />
        <div className="absolute top-0 right-0 w-2 h-2 border-t-2 border-r-2 border-current" />
        <div className="absolute bottom-0 left-0 w-2 h-2 border-b-2 border-l-2 border-current" />
        <div className="absolute bottom-0 right-0 w-2 h-2 border-b-2 border-r-2 border-current" />

        <div className="absolute -top-6 left-0 text-[10px] bg-slate-950/95 border border-slate-700/70 px-1.5 py-0.5 rounded text-slate-100 whitespace-nowrap font-medium tracking-wide shadow-lg">
          {m.label || m.id}{' '}
          {isApproximate ? (
            <span className="text-amber-400 font-bold ml-1">[ APPROX ]</span>
          ) : m.confidence ? (
            <span className="text-cyan-400 font-bold ml-1">[ {(m.confidence * 100).toFixed(1)}% ]</span>
          ) : (
            ''
          )}
        </div>

        {isActive && (
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white text-black font-extrabold text-[11px] tracking-widest px-3 py-1 rounded shadow-[0_0_20px_white] animate-pulse">
            {activePulse.actionText}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-screen w-screen bg-[#06080A] text-slate-200 flex flex-col select-none overflow-hidden font-sans">
      <style>{`@keyframes kinetix-scan { 0% { top: 0%; opacity: 0; } 10% { opacity: 1; } 90% { opacity: 1; } 100% { top: 100%; opacity: 0; } }`}</style>

      <div
        className={`fixed inset-0 z-[100] pointer-events-none bg-cyan-200/20 backdrop-brightness-150 transition-opacity duration-200 ${flashEffect ? 'opacity-100' : 'opacity-0'}`}
      />

      <canvas ref={canvasRef} className="hidden" />

      <header className="h-14 border-b border-slate-800 bg-[#0A0C10] px-6 flex items-center justify-between shadow-md z-10">
        <div className="flex items-center gap-3">
          <div className="h-3 w-3 rounded-full bg-cyan-400 shadow-[0_0_12px_#22d3ee] animate-pulse" />
          <span className="font-bold tracking-widest text-[13px] text-white">KINETIX OS</span>
          <span className="text-[10px] uppercase px-2 py-0.5 rounded bg-cyan-950/40 text-cyan-400 border border-cyan-800/60 font-semibold tracking-wider">
            SPATIAL ERP v2026.1 // KINETIX LABS
          </span>
          <span
            className={`text-[10px] px-2 py-0.5 rounded font-bold tracking-wider border ${
              backendModeBadge === 'LIVE · BASETEN'
                ? 'bg-amber-950/60 text-amber-400 border-amber-500/40'
                : 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40'
            }`}
          >
            {backendModeBadge}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <button
            onClick={() => setTtsEnabled(!ttsEnabled)}
            className={`px-2 py-1 rounded border text-[10px] font-bold cursor-pointer uppercase transition-colors ${ttsEnabled ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300' : 'border-slate-700 bg-slate-900 text-slate-500'}`}
          >
            TTS: {ttsEnabled ? 'ON' : 'OFF'}
          </button>

          <TelemetryHud telemetry={telemetry} />

          <button
            onClick={() => fileInputRef.current?.click()}
            className={`px-2.5 py-1.5 rounded border text-[10px] font-bold cursor-pointer flex items-center gap-1.5 uppercase tracking-wide transition-colors ${uploadedImage ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}
          >
            <Upload className="w-3.5 h-3.5" /> Upload Image
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              handleImageUpload(e.target.files?.[0]);
              setPhase('LIVE_IDLE');
              setMasks([]);
              setLatestCatalog(null);
              setLatestClaim(null);
              setVmExecution(null);
              setReasoningTrace('');
              setSteps(INITIAL_STEPS);
              abortStream();
              clearQueue();
              e.target.value = '';
            }}
          />

          <button
            onClick={startCamera}
            className={`px-2.5 py-1.5 rounded border text-[10px] font-bold cursor-pointer uppercase tracking-wide transition-colors ${cameraActive ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300' : 'border-slate-700 text-slate-400 hover:border-slate-500'}`}
          >
            Live Cam
          </button>

          <button
            onClick={() => {
              void fetchAuditLedger();
              setLedgerOpen(true);
            }}
            title="Shortcut: [L] key — SHA-256 Audit Ledger & Compensating Undo"
            className={`px-2.5 py-1.5 rounded border text-[10px] font-bold cursor-pointer flex items-center gap-1.5 uppercase tracking-wide transition-colors ${
              auditIntegrity.blockCount > 0
                ? 'border-emerald-600/60 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50'
                : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500'
            }`}
          >
            <Lock className="w-3.5 h-3.5 text-emerald-400" />
            <span>[L] LEDGER ({auditIntegrity.blockCount})</span>
          </button>

          <button
            onClick={resetDemoState}
            title="Shortcut: [R] key"
            className="px-2.5 py-1.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 flex items-center gap-1.5 cursor-pointer transition uppercase text-[10px] font-bold"
          >
            <RotateCcw className="w-3.5 h-3.5 text-cyan-500" />
            <span>[R] RESET</span>
          </button>
        </div>
      </header>

      <AuditLedgerDrawer
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        blocks={auditBlocks}
        integrity={auditIntegrity}
        undoingTxId={undoingTxId}
        onUndo={handleUndoTx}
      />

      <main className="flex-1 grid grid-cols-12 gap-3 p-3 overflow-hidden min-h-0">
        {/* LEFT COLUMN: SPATIAL FEED */}
        <section className="col-span-5 flex flex-col gap-3 border border-slate-800 bg-[#0A0C10] rounded-xl p-3 relative shadow-lg">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest border-b border-slate-800/80 pb-2 gap-2">
            <span className="flex items-center gap-2 font-bold text-slate-300 shrink-0">
              <Camera className="w-4 h-4 text-cyan-500" /> WORKSPACE SPATIAL FEED
            </span>
            <div className="flex items-center gap-1.5 ml-auto">
              <button
                type="button"
                onClick={() => switchBenchScene('/hardware-bench1.jpg')}
                className={`px-1.5 py-0.5 rounded font-mono text-[8.5px] font-bold border cursor-pointer transition-colors ${
                  uploadedImage === '/hardware-bench1.jpg'
                    ? 'bg-cyan-950/70 text-cyan-300 border-cyan-500/60'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:border-slate-500'
                }`}
                title="Switch to Workbench Lot #1 (Cooler, 2x DDR5 RAM, M.2 NVMe SSD, Modular PSU)"
              >
                BENCH #1
              </button>
              <button
                type="button"
                onClick={() => switchBenchScene('/hardware-bench.jpg')}
                className={`px-1.5 py-0.5 rounded font-mono text-[8.5px] font-bold border cursor-pointer transition-colors ${
                  uploadedImage === '/hardware-bench.jpg'
                    ? 'bg-cyan-950/70 text-cyan-300 border-cyan-500/60'
                    : 'bg-slate-900 text-slate-400 border-slate-700 hover:border-slate-500'
                }`}
                title="Switch to Workbench Lot #2 (Dual-Fan GPU, Mini-ITX Motherboard, AMD Ryzen CPU)"
              >
                BENCH #2
              </button>
              {phase === 'FRAME_LOCKED' && (
                <button
                  type="button"
                  onClick={() => {
                    const nextBench =
                      uploadedImage === '/hardware-bench.jpg' ? '/hardware-bench1.jpg' : '/hardware-bench.jpg';
                    switchBenchScene(nextBench);
                    speakTactical('Inbound lot committed. Advancing to next workbench.');
                  }}
                  className="px-2 py-0.5 rounded font-mono text-[8.5px] font-bold border border-emerald-500/70 bg-emerald-950/70 hover:bg-emerald-900 text-emerald-300 cursor-pointer transition-all shadow-[0_0_10px_rgba(16,185,129,0.25)]"
                  title="Confirm current lot into inventory and advance to the next workbench scene"
                >
                  ✓ COMMIT LOT & NEXT →
                </button>
              )}
              <span
                className={`px-2 py-0.5 rounded font-bold border ${phase === 'SCANNING_SCENE' ? 'bg-amber-950/80 text-amber-300 border-amber-500/50 animate-pulse' : phase === 'FRAME_LOCKED' || phase === 'EXECUTING_DAG' ? 'bg-rose-950/80 text-rose-300 border-rose-500/50' : 'bg-emerald-950/80 text-emerald-400 border-emerald-500/50'}`}
              >
                {phase === 'SCANNING_SCENE'
                  ? 'SCANNING SCENE'
                  : phase === 'FRAME_LOCKED' || phase === 'EXECUTING_DAG'
                  ? 'FRAME LOCKED'
                  : 'LIVE FEED'}
              </span>
            </div>
          </div>

          <div
            ref={stageRef}
            className="relative flex-1 min-h-0 bg-[#050608] rounded-md border border-slate-800 overflow-hidden flex items-center justify-center shadow-inner"
          >
            {cameraActive && (
              <div
                className="relative"
                style={stageBox ? { width: stageBox.w, height: stageBox.h } : { width: '100%', height: '100%' }}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  onLoadedMetadata={(e) => {
                    const target = e.currentTarget as HTMLVideoElement;
                    if (sourceDims?.w !== target.videoWidth || sourceDims?.h !== target.videoHeight) {
                      console.warn('Video dimensions updated', target.videoWidth);
                    }
                  }}
                  className="w-full h-full object-cover"
                />
                {masks.map(renderMask)}
              </div>
            )}
            {!cameraActive && uploadedImage && (
              <div
                className="relative"
                style={stageBox ? { width: stageBox.w, height: stageBox.h } : { width: '100%', height: '100%' }}
              >
                <img src={uploadedImage} alt="Workspace" className="w-full h-full object-cover" />
                {masks.map(renderMask)}
              </div>
            )}
            {!cameraActive && !uploadedImage && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-3 text-slate-600 hover:text-cyan-400 cursor-pointer transition-colors"
              >
                <Upload className="w-10 h-10" />
                <span className="text-[11px] font-medium tracking-wide uppercase">
                  Upload image or start Live Cam
                </span>
              </button>
            )}

            {phase === 'SCANNING_SCENE' && masks.length === 0 && (cameraActive || uploadedImage) && (
              <div className="absolute inset-0 pointer-events-none overflow-hidden bg-[linear-gradient(to_right,#22d3ee08_1px,transparent_1px),linear-gradient(to_bottom,#22d3ee08_1px,transparent_1px)] bg-[size:32px_32px]">
                <div
                  className="absolute left-0 right-0 h-[3px] bg-cyan-400 shadow-[0_0_24px_#22d3ee]"
                  style={{ animation: 'kinetix-scan 2s ease-in-out infinite' }}
                />
                <div className="absolute bottom-4 right-4 text-[10px] font-mono tracking-widest text-cyan-300 bg-slate-950/80 border border-cyan-500/40 px-2 py-1 rounded shadow-lg flex items-center gap-2">
                  <Zap className="w-3 h-3 text-cyan-400 animate-pulse" /> SPATIAL MAPPING IN PROGRESS
                </div>
              </div>
            )}

            {/* Human-in-the-Loop Popover (AI Suggestion + Supervisor Triage) */}
            {selectedMaskId &&
              (() => {
                const selectedMask = masks.find((m) => m.id === selectedMaskId);
                const rawLabel = (selectedMask?.label || selectedMaskId)
                  .replace(/\s*\[PENDING.*?\]/i, '')
                  .trim();
                const fallbackSlugSku = `SKU-${rawLabel.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'ASSET'}`;
                const hasPendingTriage = inventory.some((item) => item.sku.startsWith('SKU-TRIAGE-'));

                const catalogItems = inventory.filter(
                  (it) => it.sku !== 'LOADING' && !it.sku.startsWith('SKU-TRIAGE-')
                );
                const needleText = `${rawLabel} ${selectedMaskId}`.toLowerCase();
                const isRamMask = /ram|ddr|memoria|dimm|2x16|2x32|kit/.test(needleText);
                const isSsdMask = /ssd|nvme|m\.2|pcie|gen4|gen5|sata/.test(needleText);
                const isCoolerMask = /cooler|torre|heatsink|aio|fan|ventil|aleta/.test(needleText);
                const isPsuMask = /psu|fuente|power|rm1000|atx|modular|watt/.test(needleText);
                const isGpuMask = /gpu|rtx|radeon|rx|placa/.test(needleText);
                const isCpuMask = /cpu|ryzen|intel|core/.test(needleText);

                const scoredCatalog = catalogItems
                  .map((item) => {
                    const hay = `${item.sku} ${item.name}`.toLowerCase();
                    let score = 0;
                    if (isRamMask && /ddr|ram|fury|vengeance|trident/.test(hay)) score += 50;
                    if (isSsdMask && /nvme|ssd|m\.2|sata/.test(hay)) score += 50;
                    if (isCoolerMask && /cooler|tower|aio|liquid|fan/.test(hay)) score += 50;
                    if (isPsuMask && /psu|modular|gold|platinum|atx3|watt|1000w|850w/.test(hay)) score += 50;
                    if (isGpuMask && /rtx|rx|gpu|geforce|radeon/.test(hay)) score += 50;
                    if (isCpuMask && /ryzen|intel|core/.test(hay)) score += 50;
                    for (const tok of needleText.split(/[^a-z0-9]+/).filter((w) => w.length >= 2)) {
                      if (hay.includes(tok)) score += 15;
                    }
                    return { item, score };
                  })
                  .sort((a, b) => b.score - a.score);

                const topCandidates = scoredCatalog.slice(0, 3).map((s) => s.item);
                const activeSku = triageCustomMode
                  ? (triageNewSku || fallbackSlugSku).trim().toUpperCase()
                  : triageSkuChoice || topCandidates[0]?.sku || fallbackSlugSku;
                const activeCatalogItem = catalogItems.find((i) => i.sku === activeSku);
                const resolvedProductName = triageCustomMode
                  ? triageNewName.trim() || rawLabel
                  : activeCatalogItem?.name || rawLabel;
                const resolvedBaseCost = triageCustomMode
                  ? Number(triageNewCost) > 0
                    ? Number(triageNewCost)
                    : 95
                  : activeCatalogItem?.baseCostUsd;

                const commitStockWithSku = async (finalSku: string) => {
                  const cleanSku = finalSku.trim().toUpperCase() || activeSku;
                  let swappedFrom: string | undefined;
                  let effDelta = isRamMask && !hasPendingTriage ? 2 : 1;
                  try {
                    const res = await fetch(apiUrl('/api/triage/resolve'), {
                      method: 'POST',
                      headers: apiHeaders({ 'Content-Type': 'application/json' }),
                      body: JSON.stringify({
                        maskId: selectedMaskId,
                        sku: cleanSku,
                        name: resolvedProductName,
                        baseCostUsd: resolvedBaseCost,
                        action: 'STOCK',
                        delta: effDelta,
                      }),
                    });
                    const data = await res.json();
                    swappedFrom = data.swappedFromSku as string | undefined;
                    if (Number(data.effectiveDelta) > 0) {
                      effDelta = Number(data.effectiveDelta);
                    }
                    if (data.ok && Array.isArray(data.inventory)) {
                      setInventory((prev) => {
                        const prevBadges = new Map(
                          prev.map((it) => [it.sku, { _highlightDelta: it._highlightDelta, _repriced: it._repriced }])
                        );
                        if (swappedFrom) {
                          prevBadges.delete(swappedFrom);
                        }
                        const updated = data.inventory.map((it: InventoryItem) => {
                          if (it.sku === cleanSku) {
                            return {
                              ...it,
                              _highlightDelta: hasPendingTriage
                                ? 'CLEARED'
                                : swappedFrom
                                ? `OVERRIDE +${effDelta}`
                                : `+${effDelta}`,
                              _repriced: prevBadges.get(it.sku)?._repriced,
                            };
                          }
                          const kept = prevBadges.get(it.sku);
                          return kept ? { ...it, ...kept } : it;
                        });
                        const primary = updated.filter((it: InventoryItem) => it.sku === cleanSku);
                        const otherMutated = updated.filter(
                          (it: InventoryItem) => it.sku !== cleanSku && (it._highlightDelta || it._repriced)
                        );
                        const rest = updated.filter(
                          (it: InventoryItem) => it.sku !== cleanSku && !it._highlightDelta && !it._repriced
                        );
                        return [...primary, ...otherMutated, ...rest];
                      });
                    }
                    void fetchAuditLedger();
                  } catch (err) {
                    console.error('Triage stock resolve failed', err);
                  }
                  updateStep('mutate_inventory', {
                    status: 'MUTATED',
                    detail: swappedFrom
                      ? `Supervisor swapped ${swappedFrom} → ${cleanSku} (+${effDelta}) — ${resolvedProductName}`
                      : `Supervisor confirmed ${cleanSku} (+${effDelta}) — ${resolvedProductName}`,
                  });
                  speakTactical(
                    swappedFrom
                      ? `Override committed. Swapped ${swappedFrom} to ${cleanSku}.`
                      : `Stock verified for ${cleanSku}.`
                  );
                  setActivePulse({
                    id: selectedMaskId,
                    actionText: hasPendingTriage ? 'CLEARED' : `OVERRIDE +${effDelta}`,
                  });
                  setMasks((prev) =>
                    prev.map((m) =>
                      m.id === selectedMaskId
                        ? { ...m, assignedActionStatus: 'STOCK_MUTATED', label: cleanSku }
                        : m
                    )
                  );
                  setTimeout(() => setActivePulse(null), 350);
                  setSelectedMaskId(null);
                };

                return (
                  <div className="absolute bottom-3 right-3 bg-slate-950/95 border border-amber-500/60 rounded-lg p-3 w-80 shadow-[0_0_30px_rgba(0,0,0,0.9)] backdrop-blur-md z-50 animate-in fade-in slide-in-from-bottom-4">
                    <div className="flex justify-between items-start mb-2 border-b border-slate-800 pb-1.5">
                      <span className="text-[10px] font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                        <Scan className="w-3 h-3" /> SUPERVISOR TRIAGE & OVERRIDE
                      </span>
                      <button
                        onClick={() => setSelectedMaskId(null)}
                        className="text-slate-500 hover:text-white cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[11px] font-semibold text-slate-200 mb-2">
                      <span className="truncate">{rawLabel}</span>
                      <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/50">
                        AI: {((selectedMask?.confidence ?? 0.95) * 100).toFixed(0)}%
                      </span>
                    </div>

                    {/* Mode switcher: Catalog Matches vs + Add New SKU */}
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[8px] uppercase tracking-wider text-slate-400 font-bold">
                        {triageCustomMode ? 'CREATE NEW CATALOG SKU' : 'AI SUGGESTED CATALOG SKUS'}
                      </span>
                      <button
                        type="button"
                        onClick={() => setTriageCustomMode((prev) => !prev)}
                        className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
                          triageCustomMode
                            ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-300'
                            : 'border-amber-500/50 bg-amber-950/40 text-amber-300 hover:bg-amber-900/50'
                        }`}
                      >
                        {triageCustomMode ? '← PICK FROM CATALOG' : '+ NEW SKU NOT IN LIST'}
                      </button>
                    </div>

                    {!triageCustomMode ? (
                      <div className="space-y-1.5 mb-2.5">
                        <div className="space-y-1 max-h-36 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                          {topCandidates.map((cand, idx) => {
                            const selected = cand.sku === activeSku;
                            return (
                              <button
                                key={cand.sku}
                                type="button"
                                onClick={() => setTriageSkuChoice(cand.sku)}
                                className={`w-full text-left px-2 py-1.5 rounded border transition-all cursor-pointer flex items-center justify-between gap-2 ${
                                  selected
                                    ? 'border-amber-400 bg-amber-950/35 text-amber-100 shadow-[0_0_10px_rgba(251,191,36,0.2)]'
                                    : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-600'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="text-[10px] font-bold truncate flex items-center gap-1">
                                    {idx === 0 && (
                                      <span className="text-[7px] px-1 rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 font-mono">
                                        TOP
                                      </span>
                                    )}
                                    <span className="truncate">{cand.name}</span>
                                  </div>
                                  <div className="text-[8.5px] font-mono text-slate-400 truncate">
                                    {cand.sku} · Base ${cand.baseCostUsd.toFixed(0)} · Stock {cand.stock}u
                                  </div>
                                </div>
                                <span className="text-[9.5px] font-mono font-bold text-emerald-400 shrink-0">
                                  ${cand.sellPriceUsd.toFixed(2)}
                                </span>
                              </button>
                            );
                          })}
                        </div>

                        <select
                          value={activeSku}
                          onChange={(e) => setTriageSkuChoice(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[9.5px] font-mono text-slate-200 focus:outline-none focus:border-cyan-400 cursor-pointer"
                        >
                          {catalogItems.map((it) => (
                            <option key={it.sku} value={it.sku}>
                              {it.sku} — {it.name} (${it.sellPriceUsd.toFixed(2)})
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div className="space-y-1.5 mb-2.5 bg-slate-900/70 border border-slate-800 rounded p-2">
                        <div>
                          <label className="block text-[7.5px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">
                            New SKU Code
                          </label>
                          <input
                            type="text"
                            value={triageNewSku}
                            onChange={(e) => setTriageNewSku(e.target.value.toUpperCase())}
                            placeholder="SKU-BRAND-MODEL"
                            className="w-full bg-slate-950 border border-amber-500/50 rounded px-2 py-1 text-[9.5px] font-mono text-amber-200 focus:outline-none focus:border-cyan-400"
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <div className="col-span-2">
                            <label className="block text-[7.5px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">
                              Brand & Full Model
                            </label>
                            <input
                              type="text"
                              value={triageNewName}
                              onChange={(e) => setTriageNewName(e.target.value)}
                              placeholder="e.g. Kingston Fury DDR5 32GB"
                              className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-[9.5px] text-slate-200 focus:outline-none focus:border-cyan-400"
                            />
                          </div>
                          <div>
                            <label className="block text-[7.5px] uppercase tracking-wider text-slate-400 font-bold mb-0.5">
                              Cost ($ USD)
                            </label>
                            <input
                              type="number"
                              value={triageNewCost}
                              onChange={(e) => setTriageNewCost(e.target.value)}
                              className="w-full bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[9.5px] font-mono text-emerald-300 focus:outline-none focus:border-cyan-400"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <button
                        onClick={() => void commitStockWithSku(activeSku)}
                        className="w-full py-1.5 bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-700 rounded text-[10px] font-bold text-emerald-300 uppercase tracking-widest transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Package className="w-3 h-3" />{' '}
                        {triageCustomMode
                          ? 'CREATE SKU & ADD STOCK'
                          : hasPendingTriage
                          ? 'CONFIRM & CLEAR TRIAGE'
                          : `CONFIRM ${activeSku} (+${isRamMask ? 2 : 1})`}
                      </button>

                      <button
                        onClick={async () => {
                          const confirmedSku = activeSku;
                          try {
                            const res = await fetch(apiUrl('/api/triage/resolve'), {
                              method: 'POST',
                              headers: apiHeaders({ 'Content-Type': 'application/json' }),
                              body: JSON.stringify({
                                maskId: selectedMaskId,
                                sku: confirmedSku,
                                name: resolvedProductName,
                                baseCostUsd: resolvedBaseCost,
                                action: 'CLAIM',
                                reason: `Verified physical defect during supervisor triage on ${resolvedProductName} (${confirmedSku})`,
                                cropBase64: selectedMask?.cropBase64,
                              }),
                            });
                            const data = await res.json();
                            if (data.ok && data.claim) {
                              setLatestClaim(data.claim);
                            }
                            void fetchAuditLedger();
                          } catch (err) {
                            console.error('Triage claim resolve failed', err);
                          }
                          updateStep('quarantine_and_claim', {
                            status: 'MUTATED',
                            detail: `Supervisor claim opened for ${confirmedSku}`,
                          });
                          setActivePulse({ id: selectedMaskId, actionText: 'QUARANTINED' });
                          setMasks((prev) =>
                            prev.map((m) =>
                              m.id === selectedMaskId
                                ? { ...m, assignedActionStatus: 'QUARANTINED', label: confirmedSku }
                                : m
                            )
                          );
                          setTimeout(() => setActivePulse(null), 350);
                          setSelectedMaskId(null);
                        }}
                        className="w-full py-1.5 bg-rose-950/60 hover:bg-rose-900 border border-rose-800 rounded text-[10px] font-bold text-rose-300 uppercase tracking-widest transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <AlertTriangle className="w-3 h-3" /> QUARANTINE & OPEN CLAIM
                      </button>
                    </div>
                  </div>
                );
              })()}
          </div>

          <div className="flex gap-2">
            <button
              onClick={toggleRecording}
              disabled={voiceStatus === 'TRANSCRIBING'}
              title="Muse Voice Transcribe 1.0 (24kHz PCM WAV + Dynamic ERP SKU Vocabulary Biasing)"
              className={`px-3.5 py-2 rounded-md border text-[11px] font-bold flex items-center gap-2 tracking-wide transition-all cursor-pointer ${
                voiceStatus === 'RECORDING'
                  ? 'border-rose-500 bg-rose-950/60 text-rose-200 shadow-[0_0_14px_rgba(244,63,94,0.4)]'
                  : voiceStatus === 'TRANSCRIBING'
                  ? 'border-cyan-500 bg-cyan-950/50 text-cyan-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-500/60'
              }`}
            >
              {voiceStatus === 'TRANSCRIBING' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-400" />
                  <span>MUSE VOICE…</span>
                </>
              ) : voiceStatus === 'RECORDING' ? (
                <>
                  <Mic className="w-4 h-4 text-rose-400 animate-pulse" />
                  <span>STOP & TRANSCRIBE</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 text-cyan-400" />
                  <span>MIC</span>
                </>
              )}
            </button>

            {!isBusy ? (
              <button
                onClick={triggerOrchestration}
                className="flex-1 py-2 rounded-md bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-extrabold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-[0_0_15px_rgba(6,182,212,0.4)] cursor-pointer"
              >
                <Play className="w-4 h-4 fill-slate-950" /> RUN SPATIAL ORCHESTRATION (SPACEBAR)
              </button>
            ) : (
              <button
                onClick={abortRun}
                className="flex-1 py-2 rounded-md bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 transition-all shadow-[0_0_15px_rgba(225,29,72,0.4)] cursor-pointer"
              >
                <XCircle className="w-4 h-4" /> [ESC] ABORT ORCHESTRATION
              </button>
            )}
          </div>

          <div className="relative">
            {voiceStatus === 'RECORDING' ? (
              <div className="mb-1 flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-rose-300 bg-rose-950/40 border border-rose-700/50 rounded px-2 py-0.5">
                <span>● REC 24kHz PCM WAV → MUSE VOICE TRANSCRIBE 1.0 (SKU VOCAB BIAS)</span>
                <span>CLICK STOP WHEN DONE</span>
              </div>
            ) : voiceBanner ? (
              <div className="mb-1 flex items-center justify-between text-[9px] font-mono text-cyan-300 bg-cyan-950/30 border border-cyan-800/40 rounded px-2 py-0.5">
                <span className="truncate">✓ {voiceBanner}</span>
                <button
                  onClick={() => setVoiceBanner(null)}
                  className="text-slate-400 hover:text-white ml-2 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            ) : null}
            <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-[8px] font-mono uppercase tracking-wider text-slate-500">PRESETS:</span>
              <button
                type="button"
                onClick={() => setVoiceText(DEFAULT_PROMPT)}
                className="px-1.5 py-0.5 rounded border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/50 text-[8px] font-mono font-bold text-rose-300 cursor-pointer transition-colors"
                title="Scenario 1: Critical structural fin damage on $78 cooler -> $66.30 claim (>= $50 USD Guardrail Hold) + 512x512 Studio Catalog + 32% Reprice"
              >
                [1] CRITICAL DAMAGE ($66.30 HOLD)
              </button>
              <button
                type="button"
                onClick={() =>
                  setVoiceText(
                    'All components arrived intact with zero physical defects; add the tower cooler, the two DDR5 RAM modules, and the M.2 NVMe SSD to inventory stock, and recalculate prices with a 32% gross margin.'
                  )
                }
                className="px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-950/30 hover:bg-emerald-900/50 text-[8px] font-mono font-bold text-emerald-300 cursor-pointer transition-colors"
                title="Scenario 2: All items intact -> $0.00 claim (No $50 USD Guardrail Hold)"
              >
                [2] INTACT INTAKE ($0.00 CLAIM)
              </button>
              <button
                type="button"
                onClick={() =>
                  setVoiceText(
                    'The M.2 storage module has an unreadable barcode label—route it to visual triage pending OCR and synthesize a 512x512 studio catalog image for the modular ATX power supply.'
                  )
                }
                className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-950/30 hover:bg-amber-900/50 text-[8px] font-mono font-bold text-amber-300 cursor-pointer transition-colors"
                title="Scenario 3: Ambiguous barcode routed to SKU-TRIAGE-PENDING + 512x512 Muse Image synthesis"
              >
                [3] OCCLUDED SKU TRIAGE (512x512)
              </button>
            </div>
            <textarea
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              className="w-full bg-[#050608] border border-slate-800 rounded-md p-2.5 text-[11px] font-mono text-slate-300 resize-none h-[4.5rem] shadow-inner focus:outline-none focus:border-cyan-800 transition-colors"
            />
          </div>
        </section>

        {/* MIDDLE COLUMN: DAG & TERMINAL */}
        <section className="col-span-4 flex flex-col gap-3 overflow-y-auto min-h-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AgentDagPanel steps={steps} />
          <ReasoningTerminal trace={reasoningTrace} isRunning={isBusy} />
        </section>

        {/* RIGHT COLUMN: ERP MICRO-INTERACTIONS */}
        <section className="col-span-3 flex flex-col gap-2.5 overflow-y-auto min-h-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* INVENTORY CARD */}
          <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-2.5 shadow-inner flex flex-col max-h-[22vh] shrink-0">
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center gap-2 shrink-0">
              <Package className="w-3.5 h-3.5 text-emerald-500" />
              <span>LIVE INVENTORY STATE (UPSERT)</span>
              <span className="ml-auto text-[8px] bg-slate-900 border border-slate-700 px-1.5 py-0.5 rounded text-slate-400 font-mono">
                {inventory.length} SKUs
              </span>
            </div>
            <div className="space-y-1.5 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-h-0 pb-1 pr-1">
              {inventory.map((item) => {
                const isTriage = item.sku.startsWith('SKU-TRIAGE-');
                return (
                  <div
                    key={item.sku}
                    className={`flex justify-between items-center text-[11px] border-b border-slate-800/50 pb-1.5 transition-all duration-500 ${isTriage ? 'bg-amber-950/20' : item._highlightDelta || item._repriced ? 'bg-emerald-950/20 rounded px-1' : ''}`}
                  >
                    <div>
                      <div className={`font-semibold ${isTriage ? 'text-amber-200' : 'text-slate-200'}`}>
                        {item.name}
                      </div>
                      <div
                        className={`text-[9px] font-mono tracking-wider flex items-center gap-1 ${isTriage ? 'text-amber-500/80 font-bold' : 'text-slate-500'}`}
                      >
                        {item.sku}
                        {isTriage && (
                          <span className="bg-amber-500/20 text-amber-300 px-1 rounded-[2px] text-[7px] border border-amber-500/30">
                            TRIAGE HOLD
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end">
                      <div className="flex items-center gap-1.5">
                        {item._highlightDelta && (
                          <span
                            className={`${isTriage ? 'bg-amber-500' : 'bg-emerald-500'} text-slate-950 font-bold px-1 rounded-[2px] text-[9px] animate-pulse`}
                          >
                            {item._highlightDelta}
                          </span>
                        )}
                        <span className={`${isTriage ? 'text-amber-400' : 'text-emerald-400'} font-bold`}>
                          {item.stock} units
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {item._repriced && (
                          <span className="bg-cyan-500 text-slate-950 font-bold px-1 rounded-[2px] text-[8px]">
                            REPRICED
                          </span>
                        )}
                        <span className={`${isTriage ? 'text-amber-500/60' : 'text-slate-400'} text-[10px] font-mono`}>
                          ${item.sellPriceUsd?.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* GUARDRAIL CLAIM CARD */}
          <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-3 shadow-inner">
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500" /> SUPPLIER CLAIM & $50 GUARDRAIL
            </div>
            {latestClaim ? (
              <div className="border border-rose-500/40 bg-rose-950/10 rounded p-2.5 text-xs space-y-2.5 transition-all duration-300">
                <div className="flex gap-3 items-center">
                  {latestClaim.cropBase64 && latestClaim.cropBase64.startsWith('data:image') && (
                    <div className="relative w-12 h-12 rounded border border-rose-500/60 overflow-hidden shrink-0">
                      <img src={latestClaim.cropBase64} alt="Defect" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-rose-500/10 mix-blend-overlay pointer-events-none" />
                    </div>
                  )}
                  <div className="flex-1">
                    <div className="flex justify-between font-bold text-rose-300 tracking-wide text-[11px]">
                      <span>TICKET #{latestClaim.id}</span>
                      <span>-${Number(latestClaim.amountUsd).toFixed(2)} USD</span>
                    </div>
                    <div className="text-[10px] text-slate-300 mt-1 leading-snug">{latestClaim.reason}</div>
                    {latestClaim.baseCostUsd !== undefined && latestClaim.damageFactor !== undefined && (
                      <div className="text-[9px] font-mono text-slate-400 mt-1">
                        {`Valuation: $${Number(latestClaim.baseCostUsd).toFixed(2)} base × ${Number(latestClaim.damageFactor).toFixed(2)} (${latestClaim.defectSeverity || 'CRITICAL'})`}
                      </div>
                    )}
                  </div>
                </div>

                {latestClaim.guardrailStatus === 'HELD_WAITING_VOICE_AUTH' ? (
                  <div className="pt-2 border-t border-rose-500/30 flex flex-col gap-2">
                    <div className="text-[9px] text-amber-400 font-bold uppercase tracking-wide">
                      ⚠ FINANCIAL GUARDRAIL: Claim (-${Number(latestClaim.amountUsd).toFixed(2)} USD) exceeds $50 limit — Held
                    </div>
                    <button
                      onClick={authorizeGuardrailClaim}
                      className="w-full py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-amber-950 font-extrabold text-[10px] uppercase tracking-widest transition-colors shadow-[0_0_10px_rgba(245,158,11,0.3)] cursor-pointer"
                    >
                      [PRESS C] AUTHORIZE & DISPATCH CLAIM
                    </button>
                  </div>
                ) : (
                  <div className="pt-2 border-t border-emerald-500/30 flex flex-col gap-1.5">
                    <div className="text-[9px] text-emerald-400 font-bold flex items-center justify-center gap-1.5 py-1 bg-emerald-950/50 border border-emerald-800/50 rounded uppercase tracking-wide">
                      <CheckCircle2 className="w-3 h-3" /> AUTHORIZED BY OPERATOR // SENT VIA {latestClaim.dispatchChannel}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-slate-600 text-center py-4 italic">
                No claims processed in current session
              </div>
            )}
          </div>

          {/* STUDIO SYNTHESIS CARD */}
          <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-3 shadow-inner shrink-0 flex flex-col min-h-0">
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" /> CROP-TO-STUDIO SYNTHESIS (MUSE IMAGE 512x512)
            </div>
            {latestCatalog ? (
              <div className="flex flex-col gap-2 overflow-y-auto [scrollbar-width:none]">
                <div className="text-[11px] font-bold text-cyan-100">{latestCatalog.title}</div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <div className="text-[8px] uppercase tracking-wider text-slate-500 font-bold">
                      BEFORE // RAW CAMERA CROP
                    </div>
                    <div className="relative rounded border border-slate-700 overflow-hidden aspect-video bg-[#050608]">
                      <img
                        src={latestCatalog.sourceCropUrl}
                        alt="Raw"
                        className="w-full h-full object-cover opacity-70 grayscale-[30%]"
                      />
                      <div className="absolute top-1 left-1 bg-black/80 backdrop-blur px-1 py-0.5 rounded-[2px] text-[8px] font-mono text-slate-300">
                        RAW_CROP
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-[8px] uppercase tracking-wider text-slate-500 font-bold">
                      AFTER // MUSE IMAGE 512x512
                    </div>
                    <div className="relative rounded border border-cyan-800/60 overflow-hidden aspect-video bg-[#050608] shadow-[0_0_12px_rgba(34,211,238,0.15)] group">
                      <img src={latestCatalog.studioImageUrl} alt="Studio" className="w-full h-full object-cover" />
                      <div className="absolute top-1 right-1 bg-cyan-950/80 backdrop-blur border border-cyan-500/50 px-1 py-0.5 rounded-[2px] text-[8px] font-mono text-cyan-300">
                        {latestCatalog.resolution || (latestCatalog.usedLiveApi ? '512x512' : 'SVG_FALLBACK')}
                      </div>
                      <a
                        href={latestCatalog.studioImageUrl}
                        download={`Studio-Render-${latestCatalog.title.replace(/\s+/g, '-')}.png`}
                        className="absolute inset-0 bg-cyan-950/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-cyan-300 font-bold text-[10px] tracking-widest gap-2 backdrop-blur-sm cursor-pointer"
                      >
                        <Download className="w-4 h-4" /> DOWNLOAD STUDIO ASSET
                      </a>
                    </div>
                  </div>
                </div>
                {latestCatalog.visualDna && (
                  <div className="grid grid-cols-2 gap-1.5 mt-1">
                    <div className="bg-slate-900 border border-slate-700/60 rounded px-1.5 py-1 flex items-center gap-1.5 truncate">
                      <span className="text-[8px] font-bold text-cyan-500 tracking-wider">GEOMETRY:</span>
                      <span className="text-[9px] text-slate-300 truncate font-medium">
                        {latestCatalog.visualDna.containerGeometry}
                      </span>
                    </div>
                    <div className="bg-slate-900 border border-slate-700/60 rounded px-1.5 py-1 flex items-center gap-1.5 truncate">
                      <span className="text-[8px] font-bold text-cyan-500 tracking-wider">PALETTE:</span>
                      <span className="text-[9px] text-slate-300 truncate font-medium">
                        {latestCatalog.visualDna.exactColorPalette}
                      </span>
                    </div>
                    <div className="bg-slate-900 border border-slate-700/60 rounded px-1.5 py-1 flex items-center gap-1.5 truncate">
                      <span className="text-[8px] font-bold text-cyan-500 tracking-wider">OCR BRAND:</span>
                      <span className="text-[9px] text-slate-300 truncate font-medium">
                        {latestCatalog.visualDna.detectedBrandOrText}
                      </span>
                    </div>
                    <div className="bg-slate-900 border border-slate-700/60 rounded px-1.5 py-1 flex items-center gap-1.5 truncate">
                      <span className="text-[8px] font-bold text-cyan-500 tracking-wider">MATERIAL:</span>
                      <span className="text-[9px] text-slate-300 truncate font-medium">
                        {latestCatalog.visualDna.surfaceMaterial}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] text-slate-600 text-center py-4 italic flex-1 flex items-center justify-center">
                Awaiting product spatial targeting...
              </div>
            )}
          </div>

          {/* BOUNDED 50MS POLICY SANDBOX CARD */}
          <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-2.5 shadow-inner shrink-0 flex flex-col min-h-0">
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-1.5 mb-1.5 flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-amber-400" /> DYNAMIC POLICY SANDBOX (BOUNDED 50ms)
            </div>
            {vmExecution ? (
              <div className="space-y-1.5">
                <pre className="text-[9px] font-mono text-cyan-300 bg-[#050608] p-2 rounded border border-slate-800/80 overflow-x-auto leading-snug max-h-[4.25rem] overflow-y-auto [scrollbar-width:thin] [scrollbar-color:#334155_#050608]">
                  {vmExecution.executedCode}
                </pre>
                <div className="flex flex-wrap items-center gap-1 text-[8.5px] font-mono">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 font-bold">
                    OUT: ${Number(vmExecution.finalPrice).toFixed(2)} USD
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-cyan-300">
                    {(vmExecution.sandboxEngine || 'quickjs-wasm').toUpperCase()} (50ms)
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-emerald-950/40 border border-emerald-800/50 text-emerald-400">
                    ASSERTIONS: {vmExecution.invariantsPassed !== false ? 'PASS' : 'FAIL'}
                  </span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300">
                    FALLBACK: {vmExecution.usedFallback ? 'TRUE' : 'FALSE'}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-[10px] text-slate-600 text-center py-2.5 italic">
                Awaiting 50ms policy sandbox execution...
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
