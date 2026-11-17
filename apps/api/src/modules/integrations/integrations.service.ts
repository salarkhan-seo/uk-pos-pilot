import { Injectable } from '@nestjs/common';

/**
 * STUB (Build-01) — no business logic. Integrations behaviour (REST API,
 * webhooks, accounting sync, API keys) is Build-02 work.
 */
@Injectable()
export class IntegrationsService {
  status(): { module: string; status: string } {
    return { module: 'integrations', status: 'stub — no business logic in Build-01' };
  }
}
