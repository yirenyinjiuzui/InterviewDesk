/** Deliver pending full frames and the worklet's short tail before closing its port. */
export function flushPcmNode(node: AudioWorkletNode): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timeout);
      node.port.removeEventListener('message', onMessage);
      resolve();
    };
    const onMessage = ({ data }: MessageEvent) => {
      if (data === 'flushed') finish();
    };
    // A suspended or failed audio context may never service the flush request.
    const timeout = setTimeout(finish, 500);
    node.port.addEventListener('message', onMessage);
    node.port.postMessage('flush');
  });
}
