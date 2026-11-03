import React from 'react';
import { Terminal } from 'lucide-react';

export const ReasoningTerminal = ({ trace, isRunning }: { trace: string; isRunning: boolean }) => {
  const lines = trace.split('\n').filter(Boolean);
  return (
    <div className="border border-slate-800 bg-[#0A0C10] rounded-lg p-3 flex-1 flex flex-col min-h-0 relative shadow-inner">
      <div className="text-[10px] uppercase tracking-widest font-bold text-slate-400 border-b border-slate-800/80 pb-2 mb-2 flex items-center gap-2">
        <Terminal className="w-3.5 h-3.5 text-cyan-500" /> SPATIAL PLAN AUDIT &amp; SPARK TRACE
      </div>
      <div className="text-[10px] font-mono text-slate-400 whitespace-pre-wrap leading-relaxed overflow-y-auto [scrollbar-width:none] flex-1">
        {lines.map((line, i) => {
          const match = line.match(/^\[(.*?)\]\s*(.*)$/);
          if (match) {
            const tag = match[1];
            const content = match[2];
            let tagColor = 'text-slate-300 bg-slate-800';
            if (tag === 'SCENE_GRAPH') tagColor = 'text-cyan-300 bg-cyan-950/60 border border-cyan-800/50';
            if (tag === 'SEMANTIC_BINDING') tagColor = 'text-emerald-300 bg-emerald-950/60 border border-emerald-800/50';
            if (tag === 'GUARDRAIL_AUDIT') tagColor = 'text-amber-300 bg-amber-950/60 border border-amber-800/50';
            if (tag === 'VISUAL_DNA') tagColor = 'text-purple-300 bg-purple-950/60 border border-purple-800/50';
            if (tag === 'LIVE_SPARK_STREAM') tagColor = 'text-sky-300 bg-sky-950/60 border border-sky-700/50 animate-pulse';

            return (
              <div key={i} className="mb-1.5 flex flex-col sm:flex-row sm:items-start gap-1.5">
                <span className={`px-1.5 py-0.5 rounded-[3px] font-bold text-[9px] whitespace-nowrap ${tagColor}`}>
                  {tag}
                </span>
                <span className="text-slate-300 leading-snug">{content}</span>
              </div>
            );
          }
          return <div key={i} className="mb-1">{line}</div>;
        })}
        {isRunning && <span className="animate-pulse text-cyan-400 text-sm align-middle">▋</span>}
        {!isRunning && lines.length === 0 && (
          <div className="text-slate-600 italic mt-2">Awaiting spatial directives...</div>
        )}
      </div>
    </div>
  );
};
