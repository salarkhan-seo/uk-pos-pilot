/**
 * @uk-pos/admin-web — public API (Build-04 Objective 2).
 *
 * A modular back-office application: typed API client + view
 * controllers/components wired to apps/api. Framework-free TypeScript;
 * the view layer is view-models + plain string rendering (see
 * render.ts), testable without a browser.
 */
export * from './api/types';
export * from './api/errors';
export * from './api/route-table';
export * from './api/http';
export * from './api/client';
export * from './api/fake-client';
export * from './catalogue/validation';
export * from './catalogue/studio';
export * from './inventory/receiving-form';
export * from './inventory/console';
export * from './crm/console';
export * from './finance/abuse';
export * from './finance/integrity';
export * from './finance/csv-columns';
export * from './finance/downloads';
export * from './finance/webhooks';
export * from './finance/reporting';
export * from './finance/exit';
export * from './render';
