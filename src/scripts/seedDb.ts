import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { INITIAL_CATALOG } from '../data/catalogSeed';
import { resolveMongoDbName } from '../services/spatialCropperAndDb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kinetix_erp';

async function seedDatabase(): Promise<void> {
  const dbName = resolveMongoDbName(MONGO_URI);
  console.log(`[Seed] Connecting to MongoDB (${dbName})...`);
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const db = client.db(dbName);

    await db.collection('inventory_catalog').deleteMany({});
    await db.collection('inventory_mutations').deleteMany({});

    const now = new Date();
    const catalogDocs = INITIAL_CATALOG.map((item) => ({
      ...item,
      updatedAt: now,
    }));
    const catalogRes = await db.collection('inventory_catalog').insertMany(catalogDocs);

    const seedEvents = INITIAL_CATALOG.map((item) => ({
      eventType: 'SEED_INITIAL',
      sku: item.sku,
      name: item.name,
      previousStock: 0,
      delta: item.stock,
      newStock: item.stock,
      baseCostUsd: item.baseCostUsd,
      sellPriceUsd: item.sellPriceUsd,
      targetMaskId: 'SEED_INITIAL',
      createdAt: now,
    }));
    await db.collection('inventory_mutations').insertMany(seedEvents);

    console.log(`[Seed] Inserted ${catalogRes.insertedCount} canonical SKUs into inventory_catalog.`);
  } catch (error) {
    console.error('[Seed] Failed to seed database:', error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void seedDatabase();
