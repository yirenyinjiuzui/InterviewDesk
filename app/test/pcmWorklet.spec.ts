import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('flushes the last partial PCM frame once before acknowledging stop', () => {
  const messages: (ArrayBuffer | string)[] = [];
  const port = {
    postMessage: (message: ArrayBuffer | string) => messages.push(message),
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  let process!: (inputs: Float32Array[][]) => boolean;
  runInNewContext(readFileSync(new URL('../src/public/pcm-worklet.js', import.meta.url), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class { port = port; },
    registerProcessor: (_: string, Processor: new () => { process: typeof process }) => {
      const instance = new Processor();
      process = instance.process.bind(instance);
    },
  });
  const input = Float32Array.from({ length: 1703 }, (_, i) => i);
  process([[input]]);
  expect(messages).toHaveLength(1);
  port.onmessage?.({ data: 'flush' });
  process([[input]]);
  expect(messages).toHaveLength(3);
  expect(new Float32Array(messages[0] as ArrayBuffer)).toEqual(input.slice(0, 1600));
  expect(new Float32Array(messages[1] as ArrayBuffer)).toEqual(input.slice(1600));
  expect(messages[2]).toBe('flushed');
});
