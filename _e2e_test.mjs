import { resolve } from 'node:path';
import { loadSettings } from '@knowself/config';

const rootDir = resolve(process.cwd());
const settings = loadSettings(rootDir);

console.log('writeback_provider_id:', JSON.stringify(settings.conversation.writeback_provider_id));
console.log('providers:', settings.providers.map(p => `${p.id} (purposes: ${p.purposes.join(',')})`).join(', '));

// Check last_error in existing DB
import Database from 'better-sqlite3';
const db = new Database(resolve(rootDir, 'data', 'profile.sqlite'));
const cols = db.pragma('table_info(sources)').map(c => c.name);
console.log('last_error in schema:', cols.includes('last_error'));
db.close();

import { createProfileStore } from '@knowself/profile-store';
import { createProviderAdapter } from '@knowself/provider-adapter';
import { createIngestion } from '@knowself/ingestion';

const store = createProfileStore({
  dbPath: resolve(rootDir, 'data', 'profile.sqlite'),
  sourcesDir: resolve(rootDir, 'data', 'sources'),
  exportsDir: resolve(rootDir, 'data', 'exports'),
});

const pa = createProviderAdapter({
  configs: settings.providers,
  toolRegistry: { getTool: () => null, listTools: () => [] },
});
await pa.init();

const ing = createIngestion({
  store, providerAdapter: pa,
  toolRegistry: { getTool: () => null, listTools: () => [] },
  sourcesDir: resolve(rootDir, 'data', 'sources'),
  distillProviderId: settings.conversation.writeback_provider_id || 'sensenova',
});

console.log('\nCreating source...');
const src = await ing.createSource({
  kind: 'paste',
  text: '我叫小李，是一名全栈开发者，住在北京。',
  original_name: '测试',
  user_note: '', user_tags: ['测试'],
});
console.log('Source created:', src.id, 'status:', src.status, 'last_error:', src.last_error);

console.log('\nRunning distill (may take up to 90s)...');
const start = Date.now();
try {
  const result = await Promise.race([
    ing.runDistill(src, {
      provider_id: 'sensenova',
      focus_hints: ['个人信息'],
      max_proposals: 4,
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT_90s')), 90_000)),
  ]);
  console.log('Distill completed in', Date.now() - start, 'ms');
  console.log('Result:', JSON.stringify(result, null, 2));
} catch (err) {
  console.error('Distill error:', err.message);
}

console.log('\nFetching updated source...');
const updated = store.sources.get(src.id);
console.log('Updated source:', updated.status, 'last_error:', updated.last_error);

const proposals = store.proposals.list(src.id);
console.log('Proposals:', proposals.length);
if (proposals.length > 0) {
  console.log('First proposal:', JSON.stringify(proposals[0], null, 2).slice(0, 500));
}

store.close();
console.log('\nDone.');
