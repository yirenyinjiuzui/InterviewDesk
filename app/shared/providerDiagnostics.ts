import type { ProviderTestRequest } from './protocol';
import { redactSecrets } from './redact';

export function safeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return redactSecrets(url.toString());
  } catch { return redactSecrets(value.split('?')[0]).slice(0, 300); }
}

export function testRoute(req: ProviderTestRequest) {
  const suffix = req.capability === 'vision' || req.capability === 'text-llm' ? '/chat/completions' : '';
  return {
    endpoint: safeEndpoint(req.baseUrl.replace(/\/+$/, '') + suffix),
    model: redactSecrets(req.model).slice(0, 150),
    proxyRoute: req.capability === 'vision' && req.proxyUrl?.trim() ? safeEndpoint('http://' + req.proxyUrl.replace(/^\w+:\/\//, '')) : 'DIRECT',
  };
}
