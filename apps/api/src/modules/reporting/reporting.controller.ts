import { Controller, Get } from '@nestjs/common';
import { ReportingService } from './reporting.service';

/** Reporting routes (Build-03, Objective 3). */
@Controller('reporting')
export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  @Get('status')
  status(): { module: string; status: string } {
    return this.reportingService.status();
  }
}
