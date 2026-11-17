/**
 * Admin Web Dashboard Shell — HTTP server (Build-05 Objective 4, Worker D).
 *
 * Dependency-free: Node's built-in `http` only, HTML strings rendered by
 * the shell. Default port 3131 (override with ADMIN_WEB_PORT).
 *
 * By default the server boots against the seeded demo client (see
 * demo-data.ts) and every page carries the DEMO DATA badge. To point it
 * at a live API instead, set ADMIN_API_BASE_URL + ADMIN_API_TOKEN and
 * the server builds a live PosApiClient (dataSource 'live'); the VAT
 * period read then degrades as documented in shell.ts (G-UI-02).
 *
 * Build-08 Objective 3: with DEMO_SEED_ON_BOOT=true the shell defaults
 * to the demo-seeded API (base http://localhost:3127, demo key, demo
 * tenant/location, owner operator), so one flag boots a live shell
 * against a demo-seeded API. Explicit ADMIN_* vars still win.
 *
 * Routes (all read-only GETs except the POST actions listed):
 *   GET  / | /catalogue | /inventory | /crm | /finance | /webhooks | /exit
 *   GET  /health
 *   GET  /download/z-report/:id | /download/vat-period/:id  (CSV, Arch-02 §5.3)
 *   POST /catalogue/variants/create | /catalogue/price-books/create |
 *        /catalogue/price-books/entries | /catalogue/vouchers/generate
 *   POST /inventory/goods-in | /inventory/reorder-suggestions/:id/accept |
 *        /inventory/reorder-suggestions/:id/dismiss |
 *        /inventory/purchase-orders/:id/send | /inventory/transfers/create |
 *        /inventory/warehouses/create | /inventory/suppliers/create |
 *        /inventory/suppliers/link-variant
 *   POST /finance/vat-periods/:id/close | /finance/settlements/reconcile
 *   POST /webhooks/endpoints/:id/rotate-secret |
 *        /webhooks/deliveries/:id/replay | /discard
 *   POST /exit/request-termination | /begin-export-window | /full-export | /schedule-hard-delete
 *   POST /crm/export | /crm/erase
 * POST actions redirect (303) back to their view, except actions whose
 * result must be displayed once (bulk vouchers, secret rotation,
 * settlement reconciliation, VAT close), which re-render with the
 * result; a failed action re-renders its view with the API error in an
 * error box (400), never a 500 crash (Build-06 Obj 3). A D-11
 * termination block re-renders the exit portal with the exact blocking
 * ids instead of redirecting.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  DEMO_API_KEY,
  DEMO_LOCATION_ID,
  DEMO_OWNER_ID,
  DEMO_TENANT_ID,
} from '@uk-pos/db';
import { PosApiClient } from '../api/client';
import { TerminationBlockedError } from '../api/errors';
import { createDemoShell } from './demo-data';
import { createAdminDashboardShell, type AdminDashboardShell, type RenderExtra } from './shell';
import type { ActionResult } from './types';

export const DEFAULT_ADMIN_WEB_PORT = 3131;

export function adminWebPort(): number {
  const raw = process.env.ADMIN_WEB_PORT;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ADMIN_WEB_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ADMIN_WEB_PORT;
}

/**
 * Build a live shell when ADMIN_API_BASE_URL + ADMIN_API_TOKEN are set; otherwise the demo shell.
 *
 * Build-08 Objective 3: with DEMO_SEED_ON_BOOT=true, default to the
 * demo-seeded API (packages/db demo-seed.ts) — base URL, demo key,
 * demo tenant/location and the owner operator — so one flag boots a
 * live shell. Explicit ADMIN_* vars still win; without the flag the
 * previous behaviour (explicit vars or the demo shell) is unchanged.
 */
export function createShellFromEnv(): AdminDashboardShell {
  const demoSeed = process.env.DEMO_SEED_ON_BOOT === 'true';
  const baseUrl = process.env.ADMIN_API_BASE_URL ?? (demoSeed ? 'http://localhost:3127' : undefined);
  const token = process.env.ADMIN_API_TOKEN ?? (demoSeed ? DEMO_API_KEY : undefined);
  if (baseUrl !== undefined && baseUrl.trim() !== '' && token !== undefined && token.trim() !== '') {
    // Build-07 Obj 3: the Build-02 routes (e.g. listVariants) still
    // require the actor headers, and without x-user-id every live
    // render that loads them fails with "Missing required header:
    // x-user-id" — surfacing as "Variants unavailable: ..." on the
    // page. The shell operator is identified by ADMIN_USER_ID /
    // ADMIN_USER_ROLES (same trust model as the API key itself).
    const actorUserId = process.env.ADMIN_USER_ID ?? (demoSeed ? DEMO_OWNER_ID : undefined);
    const actorRoles =
      process.env.ADMIN_USER_ROLES === undefined
        ? demoSeed
          ? ['owner']
          : undefined
        : process.env.ADMIN_USER_ROLES.split(',').map((role) => role.trim()).filter(Boolean);
    const client = new PosApiClient({
      baseUrl,
      credentials: {
        token,
        tenantId: process.env.ADMIN_TENANT_ID ?? (demoSeed ? DEMO_TENANT_ID : undefined),
        locationId: process.env.ADMIN_LOCATION_ID ?? (demoSeed ? DEMO_LOCATION_ID : undefined),
      },
      ...(actorUserId === undefined
        ? {}
        : {
            demoActor: {
              userId: actorUserId,
              locationId: process.env.ADMIN_LOCATION_ID ?? (demoSeed ? DEMO_LOCATION_ID : undefined),
              roles: actorRoles,
            },
          }),
    });
    // Build-06 Objective 4: the VAT-period read route landed with
    // the E2E work (G-UI-02 resolved), so the live shell wires the
    // getVatPeriod resolver the finance view already accepts.
    // The tenant id (ADMIN_TENANT_ID) is passed through so the exit
    // portal can fetch live statutory-archive records.
    return createAdminDashboardShell(client, {
      dataSource: 'live',
      tenantId: process.env.ADMIN_TENANT_ID ?? (demoSeed ? DEMO_TENANT_ID : undefined),
      getVatPeriod: (vatPeriodId: string) => client.getVatPeriod(vatPeriodId),
    });
  }
  return createDemoShell().shell;
}

function actionError(error: unknown): ActionResult {
  return { message: error instanceof Error ? error.message : String(error), ok: false };
}

/** Re-render a view with a failed action surfaced on the page (400, never a 500 crash). */
async function renderActionError(
  res: ServerResponse,
  shell: AdminDashboardShell,
  view: 'catalogue' | 'inventory' | 'crm' | 'finance' | 'webhooks' | 'exit',
  query: { zReportId?: string | null; vatPeriodId?: string | null; customerId?: string | null; searchQuery?: string | null },
  error: unknown,
): Promise<void> {
  sendHtml(res, 400, await shell.renderView(view, query, { action: actionError(error) }));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
  });
}

export function createAdminWebServer(shell: AdminDashboardShell): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', shell: 'admin-web', dataSource: shell.dataSource }));
          return;
        }

        if (method === 'GET' && path === '/') {
          sendHtml(res, 200, await shell.renderHomePage());
          return;
        }
        if (method === 'GET' && path === '/catalogue') {
          sendHtml(res, 200, await shell.renderView('catalogue'));
          return;
        }
        if (method === 'GET' && path === '/inventory') {
          sendHtml(res, 200, await shell.renderView('inventory'));
          return;
        }
        if (method === 'GET' && path === '/crm') {
          sendHtml(
            res,
            200,
            await shell.renderView('crm', {
              customerId: url.searchParams.get('customer'),
              searchQuery: url.searchParams.get('q'),
            }),
          );
          return;
        }
        if (method === 'GET' && path === '/finance') {
          sendHtml(
            res,
            200,
            await shell.renderView('finance', {
              zReportId: url.searchParams.get('z'),
              vatPeriodId: url.searchParams.get('vat'),
            }),
          );
          return;
        }
        if (method === 'GET' && path === '/webhooks') {
          sendHtml(res, 200, await shell.renderView('webhooks'));
          return;
        }
        if (method === 'GET' && path === '/exit') {
          sendHtml(res, 200, await shell.renderView('exit'));
          return;
        }

        const zCsv = /^\/download\/z-report\/([^/]+)$/.exec(path);
        if (method === 'GET' && zCsv !== null) {
          const download = await shell.downloads.download('z-report', decodeURIComponent(zCsv[1] ?? ''));
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${download.filename}"`,
          });
          res.end(download.content);
          return;
        }
        const vatCsv = /^\/download\/vat-period\/([^/]+)$/.exec(path);
        if (method === 'GET' && vatCsv !== null) {
          const download = await shell.downloads.download('vat-period', decodeURIComponent(vatCsv[1] ?? ''));
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${download.filename}"`,
          });
          res.end(download.content);
          return;
        }

        if (method === 'POST' && path === '/catalogue/products/create') {
          const body = await readBody(req);
          try {
            // Build-12 Objective 2: an age-restricted product carries
            // a nested rule (Challenge 25, min age from the form,
            // default 18) — the server inserts it atomically with the
            // product as a first-class product-level rule.
            const ageRestricted = body.get('ageRestricted') === '1';
            const minAgeRaw = (body.get('minAge') ?? '').trim();
            const minAge = minAgeRaw === '' ? 18 : Number.parseInt(minAgeRaw, 10);
            const result = await shell.catalogue.createProduct({
              name: body.get('name') ?? '',
              description: body.get('description') || null,
              ageRestriction: ageRestricted
                ? { requiresChallenge25: true, minAge: Number.isInteger(minAge) ? minAge : 18 }
                : null,
            });
            if (!result.ok) {
              await renderActionError(res, shell, 'catalogue', {}, new Error(result.errors.join(' ')));
              return;
            }
          } catch (error) {
            // API errors throw (unlike validation failures, which return
            // { ok: false }): surface them on the page, never a 500.
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/age-restrictions/delete') {
          const body = await readBody(req);
          try {
            // Build-12 Objective 2: delete one rule. A product-level
            // delete also removes its 'inherited' variant rows, never
            // an 'explicit' override (server-enforced).
            const ruleId = (body.get('ruleId') ?? '').trim();
            if (ruleId === '') {
              throw new Error('Choose a rule to delete.');
            }
            await shell.catalogue.deleteAgeRestriction(ruleId);
          } catch (error) {
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/variants/create') {
          const body = await readBody(req);
          try {
            const result = await shell.catalogue.createVariant({
              productId: body.get('productId') ?? '',
              sku: body.get('sku') ?? '',
              barcode: body.get('barcode') || null,
              name: body.get('name') ?? '',
              pricePence: body.get('pricePence') ?? '0',
              costPence: body.get('costPence') ?? '0',
              // Build-08 Objective 1: the tax rate comes from the form's
              // picker (GET /v1/tax-rates). It was hardcoded to null
              // before, so live creation always 400d with
              // "tax_rate_id is required for a variant".
              taxRateId: body.get('taxRateId') || null,
              isBundle: false,
              attributes: [],
              bundleComponents: [],
            });
            if (!result.ok) {
              await renderActionError(res, shell, 'catalogue', {}, new Error(result.errors.join(' ')));
              return;
            }
          } catch (error) {
            // API errors throw (unlike validation failures, which return
            // { ok: false }): surface them on the page, never a 500.
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/variants/update') {
          const body = await readBody(req);
          try {
            // Build-12 Objective 3: only the fields the operator
            // filled in are sent — a blank field keeps its current
            // value (the server updates only the fields supplied).
            // The tax-rate picker sends '' for "keep current".
            const variantId = (body.get('variantId') ?? '').trim();
            if (variantId === '') {
              throw new Error('Choose a variant to update.');
            }
            const sku = (body.get('sku') ?? '').trim();
            const barcode = (body.get('barcode') ?? '').trim();
            const pricePence = (body.get('pricePence') ?? '').trim();
            const costPence = (body.get('costPence') ?? '').trim();
            const taxRateId = body.get('taxRateId') ?? '';
            const status = body.get('status') ?? '';
            const result = await shell.catalogue.updateVariant(variantId, {
              ...(sku === '' ? {} : { sku }),
              ...(barcode === '' ? {} : { barcode }),
              ...(pricePence === '' ? {} : { pricePence }),
              ...(costPence === '' ? {} : { costPence }),
              ...(taxRateId === '' ? {} : { taxRateId }),
              ...(status === '' ? {} : { status: status as 'active' | 'inactive' }),
            });
            if (!result.ok) {
              await renderActionError(res, shell, 'catalogue', {}, new Error(result.errors.join(' ')));
              return;
            }
          } catch (error) {
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/price-books/create') {
          const body = await readBody(req);
          try {
            await shell.catalogue.createPriceBook({
              name: body.get('name') ?? '',
              priority: Number(body.get('priority') ?? '0'),
              effectiveFrom: body.get('effectiveFrom') ?? '',
              effectiveTo: body.get('effectiveTo') || null,
            });
          } catch (error) {
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/price-books/entries') {
          const body = await readBody(req);
          const priceBookId = body.get('priceBookId') ?? '';
          const variantId = body.get('variantId') ?? '';
          const pricePence = body.get('pricePence') ?? '0';
          const mode = body.get('mode') ?? 'upsert';
          try {
            if (mode === 'update') {
              await shell.updatePriceBookEntry(priceBookId, variantId, pricePence);
            } else {
              await shell.setPriceBookEntry(priceBookId, variantId, pricePence);
            }
          } catch (error) {
            await renderActionError(res, shell, 'catalogue', {}, error);
            return;
          }
          redirect(res, '/catalogue');
          return;
        }

        if (method === 'POST' && path === '/catalogue/vouchers/generate') {
          const body = await readBody(req);
          const promotionId = body.get('promotionId') || null;
          const count = Number(body.get('count') ?? '0');
          const maxUses = Number(body.get('maxUses') ?? '1');
          const validTo = body.get('validTo') || null;
          try {
            const result = await shell.generateBulkVouchers(promotionId, { count, maxUses, validTo });
            // Show-once: the codes are rendered exactly once, in this
            // response only. They are never stored, logged or re-shown.
            const extra: RenderExtra = {
              justIssuedCodes: result.issuedCodes,
              justIssuedPromotionId: result.promotionId,
              action: {
                message: `${result.issuedCodes.length} voucher code(s) generated — shown once below. Copy them now; they will never be displayed again.`,
                ok: true,
              },
            };
            sendHtml(res, 200, await shell.renderView('catalogue', {}, extra));
          } catch (error) {
            await renderActionError(res, shell, 'catalogue', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/inventory/goods-in') {
          const body = await readBody(req);
          const poId = body.get('poId') || null;
          const supplierId = body.get('supplierId') || 'supplier-demo';
          const locationId = body.get('locationId') || 'loc-demo-1';
          const warehouseId = body.get('warehouseId') || 'wh-demo-1';
          // Lines arrive as received:<variantId> / damaged:<variantId> /
          // short:<variantId>; a manual single-line form sends variantId
          // + quantityOrdered + quantityReceived + costPence directly.
          const lines: Array<{ variantId: string; quantityOrdered?: string; quantityReceived: string; quantityDamaged: string; quantityShort: string; costPence: string }> = [];
          const manualVariant = body.get('variantId');
          if (manualVariant !== null && manualVariant !== '') {
            lines.push({
              variantId: manualVariant,
              // Build-07 Obj 3: the manual form's ordered quantity was
              // dropped — the submit below fell back to the loaded PO
              // lines (empty for a manual receipt), so quantityOrdered
              // was always '0' and any received > 0 failed validation.
              quantityOrdered: body.get('quantityOrdered') ?? '0',
              quantityReceived: body.get('quantityReceived') ?? '0',
              quantityDamaged: '0',
              quantityShort: '0',
              costPence: body.get('costPence') ?? '0',
            });
          } else {
            const variantIds = new Set<string>();
            for (const key of body.keys()) {
              const match = /^received:(.+)$/.exec(key);
              if (match !== null && match[1] !== undefined) variantIds.add(match[1]);
            }
            for (const variantId of variantIds) {
              lines.push({
                variantId,
                quantityReceived: body.get(`received:${variantId}`) ?? '0',
                quantityDamaged: body.get(`damaged:${variantId}`) ?? '0',
                quantityShort: body.get(`short:${variantId}`) ?? '0',
                costPence: body.get(`cost:${variantId}`) ?? '0',
              });
            }
          }
          // Cost comes from the PO lines the form was built from; the
          // form renders cost as display text, so recover it from the
          // shell's loaded goods-in lines when the POST carries none.
          const loaded = await shell.loadInventoryData();
          for (const line of lines) {
            if (line.costPence === '0') {
              const known = loaded.goodsInLines.find((l) => l.variantId === line.variantId);
              if (known !== undefined) line.costPence = known.costPence;
            }
          }
          try {
            await shell.receiving.submit({
              poId,
              supplierId,
              locationId,
              warehouseId,
              lines: lines.map((l) => ({
                variantId: l.variantId,
                quantityOrdered: l.quantityOrdered ?? loaded.goodsInLines.find((g) => g.variantId === l.variantId)?.quantityOrdered ?? '0',
                quantityReceived: l.quantityReceived,
                quantityDamaged: l.quantityDamaged,
                quantityShort: l.quantityShort,
                costPence: l.costPence,
              })),
            });
          } catch (error) {
            // Validation failure: re-render inventory with the error.
            const html = await shell.renderView('inventory');
            sendHtml(res, 400, html.replace('</main>', `<div class="error">${escapeHtmlAttr(error instanceof Error ? error.message : String(error))}</div></main>`));
            return;
          }
          redirect(res, '/inventory');
          return;
        }

        const acceptSuggestion = /^\/inventory\/reorder-suggestions\/([^/]+)\/accept$/.exec(path);
        if (method === 'POST' && acceptSuggestion !== null) {
          try {
            const po = await shell.inventory.acceptSuggestion(decodeURIComponent(acceptSuggestion[1] ?? ''));
            sendHtml(
              res,
              200,
              await shell.renderView('inventory', {}, {
                action: { message: `Suggestion accepted — draft purchase order ${po.po_number} created (not sent).`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        const dismissSuggestion = /^\/inventory\/reorder-suggestions\/([^/]+)\/dismiss$/.exec(path);
        if (method === 'POST' && dismissSuggestion !== null) {
          const body = await readBody(req);
          try {
            await shell.inventory.dismissSuggestion(
              decodeURIComponent(dismissSuggestion[1] ?? ''),
              body.get('reason') ?? '',
            );
            redirect(res, '/inventory');
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        const sendPo = /^\/inventory\/purchase-orders\/([^/]+)\/send$/.exec(path);
        if (method === 'POST' && sendPo !== null) {
          try {
            const po = await shell.inventory.sendPurchaseOrder(decodeURIComponent(sendPo[1] ?? ''));
            sendHtml(
              res,
              200,
              await shell.renderView('inventory', {}, {
                action: { message: `Purchase order ${po.po_number} sent to the supplier.`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        // Build-12 Objective 3: standalone draft purchase order (one
        // line from this form). The route-table entry landed with
        // Obj 4; a live submit works end to end (demo mode works
        // through the fake).
        if (method === 'POST' && path === '/inventory/purchase-orders/create') {
          const body = await readBody(req);
          try {
            const expectedDeliveryDate = (body.get('expectedDeliveryDate') ?? '').trim();
            const po = await shell.inventory.createPurchaseOrder({
              supplierId: body.get('supplierId') ?? '',
              warehouseId: body.get('warehouseId') ?? '',
              expectedDeliveryDate: expectedDeliveryDate === '' ? null : expectedDeliveryDate,
              lines: [
                {
                  variantId: body.get('variantId') ?? '',
                  quantityOrdered: body.get('quantityOrdered') ?? '0',
                  unitCostPence: body.get('unitCostPence') ?? '0',
                },
              ],
            });
            sendHtml(
              res,
              200,
              await shell.renderView('inventory', {}, {
                action: { message: `Draft purchase order ${po.po_number} created (not sent).`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/inventory/transfers/create') {
          const body = await readBody(req);
          try {
            await shell.inventory.createTransfer({
              fromWarehouseId: body.get('fromWarehouseId') ?? '',
              toWarehouseId: body.get('toWarehouseId') ?? '',
              lines: [{ variantId: body.get('variantId') ?? '', quantity: body.get('quantity') ?? '0' }],
            });
            redirect(res, '/inventory');
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        // Warehouses + suppliers (Build-10 Objective 2). The console
        // calls the typed client, whose route-table entries landed
        // with Build-10 Obj 4; a live submit works end to end (demo
        // mode works through the fake).
        if (method === 'POST' && path === '/inventory/warehouses/create') {
          const body = await readBody(req);
          try {
            const warehouse = await shell.inventory.createWarehouse({
              locationId: body.get('locationId') ?? '',
              name: body.get('name') ?? '',
              type: body.get('type') === 'warehouse' ? 'warehouse' : 'store',
              isDefault: body.get('isDefault') === 'true',
            });
            sendHtml(
              res,
              200,
              await shell.renderView('inventory', {}, {
                action: { message: `Warehouse ${warehouse.name} created.`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/inventory/suppliers/create') {
          const body = await readBody(req);
          try {
            const supplier = await shell.inventory.createSupplier({
              name: body.get('name') ?? '',
              currency: body.get('currency') || undefined,
              leadTimeDays: body.get('leadTimeDays') === null || body.get('leadTimeDays') === '' ? null : Number(body.get('leadTimeDays')),
              minOrderValuePence: body.get('minOrderValuePence') === null || body.get('minOrderValuePence') === '' ? null : body.get('minOrderValuePence'),
            });
            sendHtml(
              res,
              200,
              await shell.renderView('inventory', {}, {
                action: { message: `Supplier ${supplier.name} created.`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/inventory/suppliers/link-variant') {
          const body = await readBody(req);
          try {
            await shell.inventory.linkSupplierVariant(body.get('supplierId') ?? '', {
              variantId: body.get('variantId') ?? '',
              supplierSku: body.get('supplierSku') || null,
              costPence: body.get('costPence') ?? '0',
              isPreferred: body.get('isPreferred') === 'true',
            });
            redirect(res, '/inventory');
          } catch (error) {
            await renderActionError(res, shell, 'inventory', {}, error);
          }
          return;
        }

        const vatClose = /^\/finance\/vat-periods\/([^/]+)\/close$/.exec(path);
        if (method === 'POST' && vatClose !== null) {
          const id = decodeURIComponent(vatClose[1] ?? '');
          const result = await shell.closeVatPeriod(id);
          sendHtml(
            res,
            200,
            await shell.renderView('finance', { vatPeriodId: id }, {
              vatPeriodJustClosed: result.closed,
              vatCloseAttempted: true,
              closedVatPeriod: result.period,
              action: { message: result.message, ok: result.closed },
            }),
          );
          return;
        }

        if (method === 'POST' && path === '/finance/settlements/reconcile') {
          const body = await readBody(req);
          try {
            const settlement = await shell.finance.reconcileSettlement(body.get('businessDate') ?? '', [
              {
                providerReference: body.get('providerReference') ?? '',
                settlementDate: body.get('settlementDate') ?? '',
                grossPence: body.get('grossPence') ?? '0',
                feePence: body.get('feePence') ?? '0',
                reserveHoldPence: body.get('reserveHoldPence') ?? '0',
                disputeDebitPence: body.get('disputeDebitPence') ?? '0',
              },
            ]);
            sendHtml(
              res,
              200,
              await shell.renderView('finance', {}, {
                settlement,
                action: { message: `Settlement reconciled for ${settlement.businessDate} (T+3 → ${settlement.settlementDate}).`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'finance', {}, error);
          }
          return;
        }

        const rotate = /^\/webhooks\/endpoints\/([^/]+)\/rotate-secret$/.exec(path);
        if (method === 'POST' && rotate !== null) {
          const body = await readBody(req);
          const grace = Number(body.get('gracePeriodHours') ?? '24');
          try {
            const result = await shell.rotateWebhookSecret(decodeURIComponent(rotate[1] ?? ''), grace);
            // Show-once: the new secret is rendered exactly once, in
            // this response only. It is never stored, logged or re-shown.
            sendHtml(
              res,
              200,
              await shell.renderView('webhooks', {}, {
                justRotatedSecret: result,
                action: {
                  message: `Secret rotated for endpoint ${result.endpoint_id} — shown once below. The previous secret stays valid until ${result.previous_secret_expires_at}.`,
                  ok: true,
                },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'webhooks', {}, error);
          }
          return;
        }

        const replay = /^\/webhooks\/deliveries\/([^/]+)\/replay$/.exec(path);
        if (method === 'POST' && replay !== null) {
          try {
            await shell.webhooks.replayDeadLetter(decodeURIComponent(replay[1] ?? ''));
            redirect(res, '/webhooks');
          } catch (error) {
            await renderActionError(res, shell, 'webhooks', {}, error);
          }
          return;
        }
        const discard = /^\/webhooks\/deliveries\/([^/]+)\/discard$/.exec(path);
        if (method === 'POST' && discard !== null) {
          try {
            await shell.webhooks.discardDeadLetter(decodeURIComponent(discard[1] ?? ''));
            redirect(res, '/webhooks');
          } catch (error) {
            await renderActionError(res, shell, 'webhooks', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/exit/request-termination') {
          try {
            await shell.exit.requestTermination();
            sendHtml(res, 200, await shell.renderView('exit', {}, { action: { message: 'Termination requested.', ok: true } }));
          } catch (error) {
            if (error instanceof TerminationBlockedError) {
              // D-11 block: re-render with the exact blocking ids.
              const message =
                `Termination blocked (D-11): open sessions ${error.openSessionIds.join(', ') || 'none'}; ` +
                `pending/unknown payments ${error.blockingPaymentAttemptIds.join(', ') || 'none'}.`;
              sendHtml(res, 200, await shell.renderView('exit', {}, { action: { message, ok: false } }));
            } else {
              await renderActionError(res, shell, 'exit', {}, error);
            }
          }
          return;
        }
        if (method === 'POST' && path === '/exit/begin-export-window') {
          try {
            await shell.exit.beginExportWindow();
            sendHtml(res, 200, await shell.renderView('exit', {}, { action: { message: '30-day export window begun.', ok: true } }));
          } catch (error) {
            await renderActionError(res, shell, 'exit', {}, error);
          }
          return;
        }
        if (method === 'POST' && path === '/exit/full-export') {
          try {
            const { result } = await shell.exit.runFullExport();
            sendHtml(
              res,
              200,
              await shell.renderView('exit', {}, {
                action: {
                  message: `Full export complete: job ${result.jobId}, ${result.fileCount} file(s), ${result.totalRows} row(s). Manifest checksums verified.`,
                  ok: true,
                },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'exit', {}, error);
          }
          return;
        }
        if (method === 'POST' && path === '/exit/schedule-hard-delete') {
          try {
            await shell.exit.scheduleHardDelete();
            sendHtml(res, 200, await shell.renderView('exit', {}, { action: { message: 'Hard delete scheduled. The 6-year statutory VAT archive is separated first.', ok: true } }));
          } catch (error) {
            await renderActionError(res, shell, 'exit', {}, error);
          }
          return;
        }

        if (method === 'POST' && path === '/crm/export') {
          const body = await readBody(req);
          const customerId = body.get('customerId') ?? '';
          try {
            await shell.crm.exportCustomer(customerId);
          } catch (error) {
            await renderActionError(res, shell, 'crm', { customerId }, error);
            return;
          }
          redirect(res, `/crm?customer=${encodeURIComponent(customerId)}`);
          return;
        }
        // Build-12 Objective 3: assign a customer to a manual
        // customer group. The route-table entry landed with Obj 4;
        // a live submit works end to end (demo mode works through
        // the fake).
        if (method === 'POST' && path === '/crm/customers/groups') {
          const body = await readBody(req);
          const customerId = (body.get('customerId') ?? '').trim();
          const groupId = (body.get('groupId') ?? '').trim();
          try {
            if (customerId === '' || groupId === '') {
              throw new Error('Choose a customer and enter a group ID.');
            }
            const membership = await shell.crm.assignCustomerToGroup(customerId, groupId);
            sendHtml(
              res,
              200,
              await shell.renderView('crm', { customerId }, {
                action: { message: `Customer assigned to group ${membership.group_id}.`, ok: true },
              }),
            );
          } catch (error) {
            await renderActionError(res, shell, 'crm', { customerId }, error);
            return;
          }
          return;
        }
        if (method === 'POST' && path === '/crm/erase') {
          const body = await readBody(req);
          const customerId = body.get('customerId') ?? '';
          const acknowledged = body.get('acknowledged') === 'true';
          const customers = await shell.crm.listCustomers();
          const customer = customers.find((c) => c.id === customerId);
          if (customer === undefined) {
            sendHtml(res, 404, '<h1>Customer not found</h1>');
            return;
          }
          try {
            const confirmation = shell.crm.requestErasure(customer);
            await shell.crm.confirmErasure(confirmation, acknowledged);
          } catch (error) {
            await renderActionError(res, shell, 'crm', { customerId }, error);
            return;
          }
          redirect(res, '/crm');
          return;
        }

        sendHtml(res, 404, '<!DOCTYPE html><html><body><h1>404 — not found</h1><p><a href="/">Back to dashboard</a></p></body></html>');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendHtml(res, 500, `<!DOCTYPE html><html><body><h1>500 — dashboard error</h1><p>${escapeHtmlAttr(message)}</p><p><a href="/">Back to dashboard</a></p></body></html>`);
      }
    })();
  });
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Start the server on the given port (default 3131); resolves with the listening server. */
export function startAdminWebServer(shell: AdminDashboardShell, port: number = adminWebPort()): Promise<Server> {
  const server = createAdminWebServer(shell);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// Runnable entry: `node dist/ui/server.js` boots the demo shell on port 3131.
if (require.main === module) {
  const shell = createShellFromEnv();
  const port = adminWebPort();
  void startAdminWebServer(shell, port).then((server) => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`UK POS admin-web shell listening on http://localhost:${actualPort} (dataSource: ${shell.dataSource})`);
  });
}
