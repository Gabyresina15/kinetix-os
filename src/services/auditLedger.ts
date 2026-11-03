import { createHash } from 'node:crypto';

export type AuditTxType =
  | 'STOCK_DELTA'
  | 'WASM_REPRICE'
  | 'SUPPLIER_CLAIM'
  | 'GUARDRAIL_AUTHORIZED'
  | 'STUDIO_SYNTH'
  | 'SUPERVISOR_TRIAGE'
  | 'COMPENSATING_UNDO';

export type UndoDescriptor =
  | { kind: 'RESTORE_STOCK'; sku: string; previousStock: number }
  | { kind: 'RESTORE_PRICE'; sku: string; previousPriceUsd: number }
  | { kind: 'REVOKE_CLAIM'; ticketId: string }
  | { kind: 'NONE' };

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
  undo: UndoDescriptor;
  metadata?: Record<string, unknown>;
}

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
const chain: AuditLedgerBlock[] = [];

function computeBlockHash(payload: {
  index: number;
  txId: string;
  timestamp: string;
  type: AuditTxType;
  skuOrRef: string;
  summary: string;
  prevHash: string;
}): string {
  const canonical = `${payload.index}|${payload.txId}|${payload.timestamp}|${payload.type}|${payload.skuOrRef}|${payload.summary}|${payload.prevHash}`;
  return createHash('sha256').update(canonical).digest('hex');
}

export function appendAuditBlock(input: {
  type: AuditTxType;
  skuOrRef: string;
  summary: string;
  undo?: UndoDescriptor;
  metadata?: Record<string, unknown>;
}): AuditLedgerBlock {
  const index = chain.length + 1;
  const prevHash = chain.length > 0 ? chain[chain.length - 1].txHash : GENESIS_HASH;
  const txId = `TX-${String(index).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const timestamp = new Date().toISOString();
  const undo = input.undo ?? { kind: 'NONE' };
  const reversible = undo.kind !== 'NONE' && input.type !== 'COMPENSATING_UNDO';

  const txHash = computeBlockHash({
    index,
    txId,
    timestamp,
    type: input.type,
    skuOrRef: input.skuOrRef,
    summary: input.summary,
    prevHash,
  });

  const block: AuditLedgerBlock = {
    index,
    txId,
    timestamp,
    type: input.type,
    skuOrRef: input.skuOrRef,
    summary: input.summary,
    prevHash,
    txHash,
    reversible,
    rolledBack: false,
    undo,
    metadata: input.metadata,
  };
  chain.push(block);
  return block;
}

export function verifyAuditChainIntegrity(): { valid: boolean; blockCount: number; headHash: string } {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < chain.length; i++) {
    const b = chain[i];
    if (b.prevHash !== expectedPrev) {
      return { valid: false, blockCount: chain.length, headHash: b.txHash };
    }
    const recomputed = computeBlockHash({
      index: b.index,
      txId: b.txId,
      timestamp: b.timestamp,
      type: b.type,
      skuOrRef: b.skuOrRef,
      summary: b.summary,
      prevHash: b.prevHash,
    });
    if (recomputed !== b.txHash) {
      return { valid: false, blockCount: chain.length, headHash: b.txHash };
    }
    expectedPrev = b.txHash;
  }
  return {
    valid: true,
    blockCount: chain.length,
    headHash: chain.length > 0 ? chain[chain.length - 1].txHash : GENESIS_HASH,
  };
}

export function getAuditBlocksNewestFirst(): AuditLedgerBlock[] {
  return [...chain].reverse();
}

export function findAuditBlock(txId: string): AuditLedgerBlock | undefined {
  return chain.find((b) => b.txId === txId);
}

export function resetAuditLedger(): void {
  chain.length = 0;
}
