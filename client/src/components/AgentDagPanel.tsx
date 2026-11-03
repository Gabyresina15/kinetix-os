import React from 'react';
import { BrainCircuit, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { ExecutionStep } from '../core/types';

export const AgentDagPanel = ({ steps }: { steps: ExecutionStep[] }) => (
  <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-3">
    <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center gap-2">
      <BrainCircuit className="w-3.5 h-3.5 text-amber-500" /> AGENT EXECUTION DAG (CONCURRENT STAGES)
    </div>
    <div className="space-y-1.5">
      {steps.map((step) => (
        <div key={step.id} className={`border rounded-[4px] p-2 text-[11px] transition-colors duration-300 ${step.status === 'RUNNING' ? 'border-cyan-500/50 bg-cyan-950/20' : step.status === 'FAILED' ? 'border-rose-500/50 bg-rose-950/20' : 'border-slate-800/60 bg-[#0D1017]'}`}>
          <div className="flex justify-between items-center">
            <span className={`font-semibold ${step.status === 'FAILED' ? 'text-rose-400' : 'text-slate-200'}`}>{step.title}</span>
            {step.status === 'MUTATED' ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 drop-shadow-[0_0_4px_#34d399]" />
            ) : step.status === 'FAILED' ? (
              <XCircle className="w-3.5 h-3.5 text-rose-500 drop-shadow-[0_0_4px_#f43f5e]" />
            ) : step.status === 'RUNNING' ? (
              <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
            ) : step.status === 'SKIPPED' ? (
              <span className="text-[8px] font-mono uppercase px-1 py-0.5 rounded bg-slate-800 text-slate-400">SKIP</span>
            ) : (
              <div className="w-2.5 h-2.5 rounded-full border border-slate-600" />
            )}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-slate-500 mt-1 font-bold">{step.model}</div>
          {step.detail && <div className={`text-[10px] mt-1 font-medium ${step.status === 'FAILED' ? 'text-rose-300' : 'text-slate-300'}`}>{step.detail}</div>}
          {step.latencyMs !== undefined && step.latencyMs > 0 && (
            <div className="text-[9px] font-mono text-cyan-600 mt-1">{step.latencyMs}ms</div>
          )}
        </div>
      ))}
    </div>
  </div>
);
