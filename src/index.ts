/* eslint-disable no-console */
import 'dotenv/config';
import os from 'node:os';

const WALLET    = process.env.WALLET || '';
const HOST_ID   = process.env.HOST_ID || 'HOST-3090-1';
const DEVICE_ID = process.env.DEVICE_ID || os.hostname();
const COORD     = process.env.COORD || 'http://127.0.0.1:8787';

if (!WALLET) {
  console.error('[miner] WALLET required');
  process.exit(1);
}

type HelloResp = {
  ok: boolean;
  bound?: boolean;
  hostId?: string;
  deviceId?: string;
  wallet?: string;
  error?: string;
};

type HostState = {
  hostId: string;
  enabled: boolean;
  wallet: string | null;
  controller?: string | null;
  attached?: string | null;
  deviceId?: string | null;
};

type ShareResp = { ok?: boolean; total?: number; error?: string };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Call /host/hello to bind device->host (or confirm binding)
async function hello(): Promise<HelloResp> {
  try {
    const r = await fetch(`${COORD}/host/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        wallet: WALLET,
      }),
    });
    const j = (await r.json()) as HelloResp;
    return j;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'hello_failed' };
  }
}

// Read enabled flag from /host-state
async function hostState(): Promise<HostState | null> {
  try {
    const r = await fetch(`${COORD}/host-state?hostId=${encodeURIComponent(HOST_ID)}`);
    return (await r.json()) as HostState;
  } catch {
    return null;
  }
}

async function share(diff: number): Promise<ShareResp> {
  try {
    const r = await fetch(`${COORD}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: WALLET,
        hostId: HOST_ID,
        deviceId: DEVICE_ID,
        difficulty: diff,
      }),
    });
    const j = (await r.json()) as ShareResp;
    if (!r.ok) return { ok: false, error: j?.error || `http_${r.status}` };
    return j;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'share_failed' };
  }
}

// Strict gate:
// - loop hello() until bound
// - check enabled via /host-state
// - only share when enabled
async function main() {
  console.log(
    `[miner] boot WALLET=${WALLET} HOST_ID=${HOST_ID} DEVICE_ID=${DEVICE_ID} COORD=${COORD}`
  );

  for (;;) {
    const h = await hello();
    if (!h.ok) {
      console.log(`[miner] hello failed ${h.error || ''}`.trim());
      await delay(2000);
      continue;
    }
    if (!h.bound) {
      console.log(`[miner] not bound yet (host=${HOST_ID} device=${DEVICE_ID}). Waiting…`);
      await delay(2000);
      continue;
    }

    const s = await hostState();
    if (!s?.enabled) {
      console.log('[miner] host is DISABLED. Waiting to be enabled…');
      await delay(3000);
      continue;
    }

    console.log('[miner] ENABLED & BOUND. Starting share loop.');
    // Share loop
    while (true) {
      // re-check enabled every few iterations (cheap)
      const randomGate = Math.random() < 0.05;
      if (randomGate) {
        const now = await hostState();
        if (!now?.enabled) {
          console.log('[miner] host turned OFF. Pausing…');
          break;
        }
      }

      const diff = Math.floor(Math.random() * 4) + 1; // demo difficulty 1..4
      const r = await share(diff);
      if (!r.ok) {
        console.log(`[miner] share blocked: ${r.error}`);
        break; // go re-hello + re-check gate
      }
      console.log(`[miner] share ok diff=${diff} total=${r.total ?? 0}`);
      await delay(750);
    }
  }
}

main().catch((e) => {
  console.error('[miner] fatal', e);
  process.exit(1);
});
