import { setTimeout as delay } from 'node:timers/promises';
export async function waitForReady({ port, active, fetchImpl = fetch, sleep = delay, attempts = 20 }) {
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT_INVALID');
  for(let attempt=0;attempt<attempts;attempt++) {
    try {
      await active();
      const response=await fetchImpl(`http://127.0.0.1:${port}/cabinet/login`,{
        headers:{'X-Forwarded-Proto':'https'},signal:AbortSignal.timeout(1500),redirect:'manual',
      });
      await response.body?.cancel();
      if(response.status===200) return;
    } catch { /* startup can take a few seconds */ }
    await sleep(1000);
  }
  throw new Error('SERVICE_NOT_READY');
}
