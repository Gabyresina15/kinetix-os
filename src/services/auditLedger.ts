import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CatalogSeedItem, INITIAL_CATALOG } from '../data/catalogSeed';

export type AuditTxType =
  | 'STOCK_DELTA'
  | 'WASM_REPRICE'
  | 'SUPPLIER_CLAIM'
  | 'GUARDRAIL_AUTHORIZED'
  | 'STUDIO_SYNTH'
  | 'SUPERVISOR_TRIAGE'
  | 'COMPENSATING_UNDO';

export type UndoDescriptor =
  | {
      kind: 'RESTORE_STOCK';
      sku: string;
      previousStock: number;
      swappedFrom?: { sku: string; previousStock: number };
    }
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

export const AUDIT_LEDGER_FILE_PATH = path.join(process.cwd(), 'data', 'erp-audit-ledger.json');

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

let lastKnownInventory: readonly CatalogSeedItem[] = INITIAL_CATALOG;
let lastKnownClaims: Record<string, unknown>[] = [];
let diskWriteQueue: Promise<void> = Promise.resolve();

export function syncAuditLedgerToDisk(
  inventory?: readonly CatalogSeedItem[],
  claims?: Record<string, unknown>[]
): Promise<void> {
  if (inventory) lastKnownInventory = inventory;
  if (claims) lastKnownClaims = claims;

  const snapshot = {
    updatedAt: new Date().toISOString(),
    integrity: verifyAuditChainIntegrity(),
    skuCount: lastKnownInventory.length,
    inventory: lastKnownInventory,
    claims: lastKnownClaims,
    blocks: getAuditBlocksNewestFirst(),
  };

  diskWriteQueue = diskWriteQueue
    .catch(() => {})
    .then(async () => {
      try {
        await fs.mkdir(path.dirname(AUDIT_LEDGER_FILE_PATH), { recursive: true });
        await fs.writeFile(AUDIT_LEDGER_FILE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
      } catch (err) {
        console.warn('[AuditLedger] Disk snapshot skipped:', (err as Error).message);
      }
    });

  return diskWriteQueue;
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
  void syncAuditLedgerToDisk();
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
  void syncAuditLedgerToDisk(INITIAL_CATALOG, []);
}
