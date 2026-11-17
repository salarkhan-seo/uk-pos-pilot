import { Controller, Get } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';

/** STUB (Build-01) — route surface only, no business logic. */
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get('status')
  status(): { module: string; status: string } {
    return this.integrationsService.status();
  }
}
