import React from 'react';
import { ShieldCheck, ShieldAlert, Undo2, X, Hash, Lock } from 'lucide-react';
import { AuditLedgerBlock, AuditChainIntegrity, AuditTxType } from '../core/types';

interface AuditLedgerDrawerProps {
  open: boolean;
  onClose: () => void;
  blocks: AuditLedgerBlock[];
  integrity: AuditChainIntegrity;
  undoingTxId: string | null;
  onUndo: (txId: string) => void;
}

const TX_BADGE_STYLE: Record<AuditTxType, string> = {
  STOCK_DELTA: 'bg-emerald-950/60 text-emerald-300 border-emerald-700/60',
  WASM_REPRICE: 'bg-cyan-950/60 text-cyan-300 border-cyan-700/60',
  SUPPLIER_CLAIM: 'bg-rose-950/60 text-rose-300 border-rose-700/60',
  GUARDRAIL_AUTHORIZED: 'bg-amber-950/60 text-amber-300 border-amber-600/60',
  STUDIO_SYNTH: 'bg-indigo-950/60 text-indigo-300 border-indigo-700/60',
  SUPERVISOR_TRIAGE: 'bg-purple-950/60 text-purple-300 border-purple-700/60',
  COMPENSATING_UNDO: 'bg-slate-800 text-amber-200 border-amber-500/50',
};

export const AuditLedgerDrawer: React.FC<AuditLedgerDrawerProps> = ({
  open,
  onClose,
  blocks,
  integrity,
  undoingTxId,
  onUndo,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex justify-end bg-black/60 backdrop-blur-[2px]">
      <div className="w-[460px] max-w-[92vw] h-full bg-[#090B0F] border-l border-slate-800 shadow-[0_0_40px_rgba(0,0,0,0.9)] flex flex-col">
        {/* HEADER */}
        <div className="px-4 py-3 border-b border-slate-800 bg-[#0C0F15] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-cyan-400" />
            <div>
              <div className="text-[11px] font-bold tracking-widest uppercase text-white">
                SHA-256 ERP AUDIT LEDGER
              </div>
              <div className="text-[9px] font-mono text-slate-400">
                Tamper-evident hash chain · Atomic compensating rollback
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded border border-slate-800 hover:border-slate-600 text-slate-400 hover:text-white cursor-pointer"
            title="Close [L]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* CHAIN INTEGRITY BAR */}
        <div className="px-4 py-2.5 border-b border-slate-800/80 bg-[#06080B] flex items-center justify-between text-[10px]">
          <div className="flex items-center gap-2">
            {integrity.valid ? (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/50 text-emerald-300 font-bold tracking-wider uppercase">
                <ShieldCheck className="w-3.5 h-3.5" /> SHA-256 CHAIN VERIFIED
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-950/70 border border-rose-500 text-rose-300 font-bold tracking-wider uppercase">
                <ShieldAlert className="w-3.5 h-3.5" /> HASH MISMATCH DETECTED
              </span>
            )}
            <span className="font-mono text-slate-400">{integrity.blockCount} blocks</span>
          </div>
          <div className="font-mono text-[9px] text-slate-500 flex items-center gap-1" title={integrity.headHash}>
            <Hash className="w-3 h-3 text-cyan-500" />
            <span>HEAD {integrity.headHash.slice(0, 10)}…</span>
          </div>
        </div>

        {/* BLOCK STREAM */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          {blocks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 px-6">
              <Hash className="w-8 h-8 text-slate-700 mb-2" />
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                Genesis Block Ready (00000000…)
              </div>
              <div className="text-[10px] mt-1">
                Run a spatial orchestration or supervisor triage to append cryptographically chained ERP mutations.
              </div>
            </div>
          ) : (
            blocks.map((block) => {
              const badgeClass = TX_BADGE_STYLE[block.type] || TX_BADGE_STYLE.STOCK_DELTA;
              const isUndoing = undoingTxId === block.txId;
              return (
                <div
                  key={block.txId}
                  className={`rounded-lg border p-2.5 bg-[#0C0F14] transition-colors ${
                    block.rolledBack ? 'border-slate-800/70 opacity-65' : 'border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] font-bold text-slate-400">
                        #{String(block.index).padStart(2, '0')}
                      </span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${badgeClass}`}>
                        {block.type}
                      </span>
                      <span className="font-mono text-[10px] text-cyan-300 font-semibold truncate max-w-[140px]">
                        {block.skuOrRef}
                      </span>
                    </div>

                    {block.rolledBack ? (
                      <span className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-400">
                        ROLLED BACK
                      </span>
                    ) : block.reversible ? (
                      <button
                        disabled={isUndoing}
                        onClick={() => onUndo(block.txId)}
                        className="px-2 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40"
                        title="Execute compensating ERP transaction and append rollback block"
                      >
                        <Undo2 className="w-3 h-3" />
                        {isUndoing ? 'ROLLING BACK…' : 'UNDO TX'}
                      </button>
                    ) : null}
                  </div>

                  <div className="text-[11px] text-slate-200 leading-snug mb-2">{block.summary}</div>

                  <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 bg-[#06080B] px-2 py-1 rounded border border-slate-800/80">
                    <span title={`prevHash: ${block.prevHash}\ntxHash: ${block.txHash}`}>
                      prev:{block.prevHash.slice(0, 8)} → sha256:<span className="text-cyan-400">{block.txHash.slice(0, 12)}</span>
                    </span>
                    <span>{new Date(block.timestamp).toLocaleTimeString()}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
