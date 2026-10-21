/**
 * Public surface of the OPS module — the asset manager (user decisions
 * 2026-10-15): the register with its append-only history, OPS setup
 * (categories, kits), the request queue, gate passes, consumable stock and
 * the employee's own view. Several filesets in one folder because they share
 * the ops domain and each other's rows. Locations are the attendance punch
 * zones.
 */
export { assetsRoutes } from './assets.routes.js';
export { registerAssetsDocs } from './assets.docs.js';
export { assetSetupRoutes } from './asset-setup.routes.js';
export { registerAssetSetupDocs } from './asset-setup.docs.js';
export { assetRequestsRoutes } from './asset-requests.routes.js';
export { registerAssetRequestsDocs } from './asset-requests.docs.js';
export { gatePassesRoutes } from './gate-passes.routes.js';
export { registerGatePassesDocs } from './gate-passes.docs.js';
export { stockRoutes } from './stock.routes.js';
export { registerStockDocs } from './stock.docs.js';
export { myAssetsRoutes } from './my-assets.routes.js';
export { registerMyAssetsDocs } from './my-assets.docs.js';
// The Exit clearance reads what a leaver still has to give back (p71).
export { createOpsCustodyReader, type OpsCustodyReader } from './assets.repository.js';
export type { AssetDto } from './assets.schema.js';
export type { AssetRequestDto } from './asset-requests.schema.js';
export type { GatePassDto } from './gate-passes.schema.js';
