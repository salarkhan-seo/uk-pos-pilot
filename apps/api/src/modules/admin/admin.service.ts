import { Injectable } from '@nestjs/common';

/**
 * AdminService (Build-02, Objective 2) — module status only. Tenancy,
 * approvals and audit live in ApprovalService / AuditService.
 */
@Injectable()
export class AdminService {
  status(): { module: string; status: string } {
    return { module: 'admin', status: 'Build-02 — approvals and audit live' };
  }
}
