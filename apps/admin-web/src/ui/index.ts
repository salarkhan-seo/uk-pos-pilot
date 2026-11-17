/**
 * @uk-pos/admin-web — Admin Web Dashboard Shell (Build-05 Objective 4, Worker D).
 *
 * A complete, rendered back-office web shell + HTTP server bound to the
 * existing AdminWebApp controllers. Framework-free, dependency-free
 * (Node built-in `http` only). Boot with `node dist/ui/server.js`
 * (default port 3131) or programmatically via startAdminWebServer.
 */
export * from './types';
export * from './views';
export * from './shell';
export * from './demo-data';
export * from './server';
