/**
 * Auth controller (Build-04 Worker 4).
 *
 * POST /v1/auth/pin-login — the PIN login route. It is deliberately NOT
 * guarded by AuthGuard: it IS the login (a scoped API key or a session
 * token is what this endpoint issues). The body carries tenantId,
 * userId and pin; SessionService verifies the PIN against the scrypt
 * hash and issues the 2h HMAC session token. Wrong PIN / disabled user
 * is 403; an unknown user or a location outside the tenant is 404.
 */
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { SessionService } from './session.service';
import { assertUuid } from '../../common/uuid';

interface PinLoginBody {
  tenantId: string;
  userId: string;
  pin: string;
  locationId?: string | null;
  isTill?: boolean;
}

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

  @Post('pin-login')
  async pinLogin(@Body() body: PinLoginBody) {
    if (typeof body.tenantId !== 'string' || body.tenantId === '') {
      throw new BadRequestException('tenantId is required');
    }
    if (typeof body.userId !== 'string' || body.userId === '') {
      throw new BadRequestException('userId is required');
    }
    if (typeof body.pin !== 'string' || body.pin === '') {
      throw new BadRequestException('pin is required');
    }
    // Build-05: malformed (non-UUID) ids are a client error (400),
    // never an unhandled 500 from a uuid cast in the database.
    // A well-formed UUID that matches nothing is still a 404 from
    // the service. The same guard lives in SessionService.login so
    // direct service callers get it too.
    assertUuid(body.tenantId, 'tenantId');
    assertUuid(body.userId, 'userId');
    if (body.locationId !== undefined && body.locationId !== null) {
      assertUuid(body.locationId, 'locationId');
    }
    return this.sessions.login({
      tenantId: body.tenantId,
      userId: body.userId,
      pin: body.pin,
      locationId: body.locationId ?? null,
      isTill: body.isTill ?? false,
    });
  }
}
