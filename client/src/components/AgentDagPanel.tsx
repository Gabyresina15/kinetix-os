import React, { useEffect, useState } from 'react';
import { BrainCircuit, CheckCircle2, XCircle, Loader2, AlertTriangle } from 'lucide-react';
import { ExecutionStep } from '../core/types';

export const AgentDagPanel = ({ steps }: { steps: ExecutionStep[] }) => {
  const anyRunning = steps.some((s) => s.status === 'RUNNING');
  const [elapsedTickMs, setElapsedTickMs] = useState(0);

  useEffect(() => {
    if (!anyRunning) {
      setElapsedTickMs(0);
      return;
    }
    const started = performance.now();
    const id = window.setInterval(() => {
      setElapsedTickMs(Math.round(performance.now() - started));
    }, 100);
    return () => window.clearInterval(id);
  }, [anyRunning]);

  return (
    <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <BrainCircuit className="w-3.5 h-3.5 text-amber-500" /> AGENT EXECUTION DAG (CONCURRENT STAGES)
        </span>
        {anyRunning && (
          <span className="text-[9px] font-mono text-cyan-400 bg-cyan-950/60 border border-cyan-500/40 px-1.5 py-0.5 rounded animate-pulse">
            PARALLEL PIPELINE · {(elapsedTickMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      <div className="space-y-1.5">
        {steps.map((step) => {
          const isHeldGuardrail =
            step.status === 'MUTATED' && Boolean(step.detail && /held by \$50 guardrail/i.test(step.detail));
          return (
            <div
              key={step.id}
              className={`relative overflow-hidden border rounded-[4px] p-2 text-[11px] transition-colors duration-300 ${
                step.status === 'RUNNING'
                  ? 'border-cyan-500/60 bg-cyan-950/25 shadow-[0_0_14px_rgba(34,211,238,0.12)]'
                  : step.status === 'FAILED'
                  ? 'border-rose-500/50 bg-rose-950/20'
                  : isHeldGuardrail
                  ? 'border-amber-500/50 bg-amber-950/15'
                  : 'border-slate-800/60 bg-[#0D1017]'
              }`}
            >
              <div className="flex justify-between items-center">
                <span
                  className={`font-semibold ${
                    step.status === 'FAILED'
                      ? 'text-rose-400'
                      : isHeldGuardrail
                      ? 'text-amber-200'
                      : step.status === 'RUNNING'
                      ? 'text-cyan-100'
                      : 'text-slate-200'
                  }`}
                >
                  {step.title}
                </span>
                {isHeldGuardrail ? (
                  <span className="text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 flex items-center gap-1 animate-pulse">
                    <AlertTriangle className="w-3 h-3 text-amber-400" /> HELD ≥ $50
                  </span>
                ) : step.status === 'MUTATED' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 drop-shadow-[0_0_4px_#34d399]" />
                ) : step.status === 'FAILED' ? (
                  <XCircle className="w-3.5 h-3.5 text-rose-500 drop-shadow-[0_0_4px_#f43f5e]" />
                ) : step.status === 'RUNNING' ? (
                  <span className="flex items-center gap-1.5">
                    <span className="text-[8.5px] font-mono text-cyan-300">
                      {((step.latencyMs || elapsedTickMs) / 1000).toFixed(1)}s
                    </span>
                    <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                  </span>
                ) : step.status === 'SKIPPED' ? (
                  <span className="text-[8px] font-mono uppercase px-1 py-0.5 rounded bg-slate-800 text-slate-400">
                    SKIP
                  </span>
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full border border-slate-600" />
                )}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-slate-500 mt-1 font-bold">{step.model}</div>
              {step.detail && (
                <div
                  className={`text-[10px] mt-1 font-medium ${
                    step.status === 'FAILED'
                      ? 'text-rose-300'
                      : isHeldGuardrail
                      ? 'text-amber-300'
                      : step.status === 'RUNNING'
                      ? 'text-cyan-200/90'
                      : 'text-slate-300'
                  }`}
                >
                  {step.detail}
                </div>
              )}
              {step.status !== 'RUNNING' && step.latencyMs !== undefined && step.latencyMs > 0 && (
                <div className="text-[9px] font-mono text-cyan-600 mt-1">{step.latencyMs}ms</div>
              )}
              {step.status === 'RUNNING' && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-cyan-950 overflow-hidden">
                  <div className="h-full w-1/2 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
