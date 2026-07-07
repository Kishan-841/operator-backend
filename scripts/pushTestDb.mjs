/**
 * Sync the Prisma schema to the TEST database. Run via `npm run test:db`
 * (which loads .env.test). Guarded so it can never target a non-test DB.
 */
import { execFileSync } from 'node:child_process';

const url = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(url)) {
  console.error(`Refusing: DATABASE_URL is not a *_test database (${url}).`);
  process.exit(1);
}

console.log(`Pushing schema to ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
// Fixed argument vector, no shell — npx resolves the local prisma CLI.
execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});
