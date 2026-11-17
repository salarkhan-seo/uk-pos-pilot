import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RateLimitInterceptor } from './common/rate-limit.interceptor';
import { RateLimiter } from './common/rate-limiter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Build-03 Objective 1 (Arch-02 §2.4): leaky-bucket rate limiting on
  // every response — X-RateLimit-* headers, 429 + Retry-After when a
  // bucket is exhausted. Till checkout calls are exempt from hard 429
  // rejection (the interceptor checks the actor's till session flag).
  app.useGlobalInterceptors(new RateLimitInterceptor(new RateLimiter()));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`UK POS pilot API listening on port ${port}`);
}

void bootstrap();
