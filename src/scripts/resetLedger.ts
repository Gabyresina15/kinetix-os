import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cloneInitialCatalog } from '../data/catalogSeed';
import { resetAuditLedger, syncAuditLedgerToDisk, AUDIT_LEDGER_FILE_PATH } from '../services/auditLedger';
import { getPersistenceDb } from '../services/spatialCropperAndDb';

async function resetCanonicalLedgerState(): Promise<void> {
  const cleanInventory = cloneInitialCatalog();
  resetAuditLedger();
  await syncAuditLedgerToDisk(cleanInventory, []);

  const ledgerDir = path.join(process.cwd(), 'data', 'ledger');
  try {
    await fs.rm(ledgerDir, { recursive: true, force: true });
    await fs.mkdir(ledgerDir, { recursive: true });
  } catch {
    // ignore if directory did not exist
  }

  try {
    const db = await getPersistenceDb();
    if (db) {
      await db.collection('inventory_catalog').deleteMany({});
      await db.collection('supplier_claims').deleteMany({});
      await db.collection('inventory_mutations').deleteMany({});
      await db.collection('inventory_catalog').insertMany(
        cleanInventory.map((item) => ({ ...item, updatedAt: new Date() }))
      );
      console.log(`[Reset] MongoDB collections reset to ${cleanInventory.length} canonical SKUs.`);
    }
  } catch (err) {
    console.warn(`[Reset] MongoDB offline, reset local file ledger only: ${(err as Error).message}`);
  }

  console.log(`[Reset] Restored ${AUDIT_LEDGER_FILE_PATH} to clean 31-SKU canonical seed state.`);
  process.exit(0);
}

void resetCanonicalLedgerState();
