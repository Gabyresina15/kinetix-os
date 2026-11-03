export interface CatalogSeedItem {
  sku: string;
  name: string;
  stock: number;
  standardInboundLot: number;
  baseCostUsd: number;
  sellPriceUsd: number;
}

export const INITIAL_CATALOG: readonly CatalogSeedItem[] = [
  // Processors (CPUs)
  { sku: 'SKU-INTEL-CORE-I9', name: 'Intel Core i9-14900K', stock: 12, standardInboundLot: 5, baseCostUsd: 480.0, sellPriceUsd: 599.99 },
  { sku: 'SKU-INTEL-CORE-I7', name: 'Intel Core i7-14700K', stock: 45, standardInboundLot: 10, baseCostUsd: 320.0, sellPriceUsd: 409.99 },
  { sku: 'SKU-INTEL-CORE-I5', name: 'Intel Core i5-13600K', stock: 89, standardInboundLot: 20, baseCostUsd: 210.0, sellPriceUsd: 319.99 },
  { sku: 'SKU-AMD-RYZEN-9', name: 'AMD Ryzen 9 7950X', stock: 8, standardInboundLot: 5, baseCostUsd: 450.0, sellPriceUsd: 549.99 },
  { sku: 'SKU-AMD-RYZEN-7', name: 'AMD Ryzen 7 7800X3D', stock: 32, standardInboundLot: 10, baseCostUsd: 310.0, sellPriceUsd: 399.99 },
  { sku: 'SKU-AMD-RYZEN-5', name: 'AMD Ryzen 5 7600X', stock: 112, standardInboundLot: 30, baseCostUsd: 170.0, sellPriceUsd: 249.99 },

  // Graphics Cards (GPUs)
  { sku: 'SKU-GPU-RTX4090', name: 'NVIDIA GeForce RTX 4090 24GB', stock: 3, standardInboundLot: 2, baseCostUsd: 1400.0, sellPriceUsd: 1799.99 },
  { sku: 'SKU-GPU-RTX4080', name: 'NVIDIA GeForce RTX 4080 16GB', stock: 15, standardInboundLot: 5, baseCostUsd: 950.0, sellPriceUsd: 1199.99 },
  { sku: 'SKU-GPU-RTX4070', name: 'NVIDIA GeForce RTX 4070 12GB', stock: 48, standardInboundLot: 15, baseCostUsd: 480.0, sellPriceUsd: 599.99 },
  { sku: 'SKU-GPU-RTX4060', name: 'NVIDIA GeForce RTX 4060 8GB', stock: 120, standardInboundLot: 40, baseCostUsd: 240.0, sellPriceUsd: 299.99 },
  { sku: 'SKU-GPU-RX7900XTX', name: 'AMD Radeon RX 7900 XTX 24GB', stock: 7, standardInboundLot: 3, baseCostUsd: 800.0, sellPriceUsd: 999.99 },
  { sku: 'SKU-GPU-RX7800XT', name: 'AMD Radeon RX 7800 XT 16GB', stock: 24, standardInboundLot: 10, baseCostUsd: 400.0, sellPriceUsd: 499.99 },

  // Memory (RAM)
  { sku: 'SKU-DDR5-64GB-KIT', name: 'Corsair Vengeance RGB DDR5 64GB (2x32GB)', stock: 28, standardInboundLot: 10, baseCostUsd: 160.0, sellPriceUsd: 215.0 },
  { sku: 'SKU-DDR5-32GB-KIT', name: 'Fury Beast DDR5 32GB (2x16GB) Black', stock: 14, standardInboundLot: 2, baseCostUsd: 95.0, sellPriceUsd: 158.0 },
  { sku: 'SKU-DDR4-32GB-KIT', name: 'G.Skill Ripjaws V DDR4 32GB (2x16GB)', stock: 156, standardInboundLot: 50, baseCostUsd: 45.0, sellPriceUsd: 65.99 },
  { sku: 'SKU-DDR4-16GB-KIT', name: 'Crucial Ballistix DDR4 16GB (2x8GB)', stock: 210, standardInboundLot: 50, baseCostUsd: 28.0, sellPriceUsd: 44.99 },

  // Storage (NVMe / SATA SSD)
  { sku: 'SKU-NVME-4TB-GEN4', name: 'Samsung 990 PRO NVMe M.2 4TB', stock: 12, standardInboundLot: 5, baseCostUsd: 250.0, sellPriceUsd: 345.0 },
  { sku: 'SKU-NVME-2TB-GEN4', name: 'M.2 NVMe PCIe 4.0 SSD 2TB', stock: 8, standardInboundLot: 1, baseCostUsd: 110.0, sellPriceUsd: 185.0 },
  { sku: 'SKU-NVME-1TB-GEN4', name: 'WD_BLACK SN850X NVMe M.2 1TB', stock: 84, standardInboundLot: 20, baseCostUsd: 65.0, sellPriceUsd: 89.99 },
  { sku: 'SKU-SSD-2TB-SATA', name: 'Crucial MX500 2TB 3D NAND SATA', stock: 45, standardInboundLot: 15, baseCostUsd: 75.0, sellPriceUsd: 110.99 },

  // Motherboards
  { sku: 'SKU-MB-Z790', name: 'ASUS ROG Maximus Z790 Hero', stock: 5, standardInboundLot: 2, baseCostUsd: 480.0, sellPriceUsd: 629.99 },
  { sku: 'SKU-MB-B760', name: 'MSI MAG B760 Tomahawk WiFi', stock: 34, standardInboundLot: 10, baseCostUsd: 140.0, sellPriceUsd: 189.99 },
  { sku: 'SKU-MB-X670E', name: 'Gigabyte X670E AORUS Master', stock: 9, standardInboundLot: 3, baseCostUsd: 360.0, sellPriceUsd: 489.99 },
  { sku: 'SKU-MB-B650', name: 'ASRock B650E PG Riptide WiFi', stock: 42, standardInboundLot: 15, baseCostUsd: 165.0, sellPriceUsd: 239.99 },

  // Power Supplies (PSU)
  { sku: 'SKU-PSU-1000W-ATX3', name: 'Corsair RM1000x Shift 80 PLUS Gold ATX 3.0', stock: 18, standardInboundLot: 5, baseCostUsd: 140.0, sellPriceUsd: 209.99 },
  { sku: 'SKU-PSU-850W-GOLD', name: 'EVGA SuperNOVA 850 G6 80 Plus Gold', stock: 36, standardInboundLot: 10, baseCostUsd: 105.0, sellPriceUsd: 149.99 },
  { sku: 'SKU-PSU-650W-BRONZE', name: 'Thermaltake Smart BM2 650W 80+ Bronze', stock: 75, standardInboundLot: 25, baseCostUsd: 40.0, sellPriceUsd: 64.99 },

  // Cooling (AIO & Air Tower Coolers)
  { sku: 'SKU-AIO-360MM', name: 'NZXT Kraken Elite 360 RGB AIO', stock: 14, standardInboundLot: 5, baseCostUsd: 190.0, sellPriceUsd: 279.99 },
  { sku: 'SKU-AIO-240MM', name: 'Cooler Master MasterLiquid ML240L', stock: 42, standardInboundLot: 10, baseCostUsd: 60.0, sellPriceUsd: 89.99 },
  { sku: 'SKU-AIR-DUAL-TOWER', name: 'Noctua NH-D15 chromax.black', stock: 26, standardInboundLot: 10, baseCostUsd: 95.0, sellPriceUsd: 139.99 },
  { sku: 'SKU-AIR-SINGLE-TOWER', name: 'Tower Cooler 120mm Copper Heatpipes', stock: 34, standardInboundLot: 10, baseCostUsd: 78.0, sellPriceUsd: 114.99 },
];

export function cloneInitialCatalog(): CatalogSeedItem[] {
  return INITIAL_CATALOG.map((item) => ({ ...item }));
}
