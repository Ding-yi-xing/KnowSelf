function extractJsonBlock(text) {
  const noFence = text.replace(/`[a-z]*\s*([\s\S]*?)\s*`/g, '').trim();
  const start = noFence.indexOf('{');
  const end = noFence.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return noFence.slice(start, end + 1);
}

async function test() {
  // Load the real dist and try with a mock chat
  const { requestStructured } = await import('./packages/provider-adapter/dist/structured.js');

  // Add a console.log to see what lastText contains
  // Instead, let's call requestStructured with a mock that logs
  const mockRegistry = {
    getConfig: () => ({ request_timeout_ms: 5000 }),
  };
  
  try {
    const result = await requestStructured(
      { registry: mockRegistry },
      {
        provider_id: 'test',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'test' }] }],
        schema: { parse: (v) => v },
        schemaName: 'Test',
      },
    );
    console.log('Result:', result);
  } catch(e) {
    console.log('Error:', e.message);
  }
}

test();
