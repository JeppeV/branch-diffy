// Run with the test runner's Node (22+), which provides a built-in WebSocket client.
// The extension host cannot inspect the workbench DOM through the public VS Code API.
async function main() {
  const [port, expression] = process.argv.slice(2);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find((target) => target.type === 'page' && target.url.includes('workbench'));
  if (!target) {
    throw new Error('VS Code workbench debugger target not found');
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Workbench evaluation timed out')), 5000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        error ? reject(error) : resolve(value);
      };
      socket.addEventListener('error', () => finish(new Error('Workbench debugger connection failed')), { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true },
      })), { once: true });
      socket.addEventListener('message', (event) => {
        const response = JSON.parse(event.data);
        if (response.id === 1) {
          const error = response.error ?? response.result?.exceptionDetails;
          finish(error ? new Error(JSON.stringify(error)) : undefined, response.result?.result?.value);
        }
      });
    });
    console.log(JSON.stringify(result));
  } finally {
    socket.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
