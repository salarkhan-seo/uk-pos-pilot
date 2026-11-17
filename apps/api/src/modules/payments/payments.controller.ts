import { Controller, Get } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/** STUB (Build-01) — route surface only, no business logic. */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('status')
  status(): { module: string; status: string } {
    return this.paymentsService.status();
  }
}
