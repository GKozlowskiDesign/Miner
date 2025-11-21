/* eslint-disable no-console */
import 'dotenv/config';
import os from 'node:os';
import { execSync } from 'node:child_process';

const WALLET = process.env.WALLET || '';
const HOST_ID = process.env.HOST_ID || 'HOST-3090-1';
const DEVICE_ID = process.env.DEVICE_ID || os.hostname();
const COORD = process.env.COORD || 'http://127.0.0.1:8787';

if (!WALLET) {
  console.error('[miner] WALLET required');
  process.exit(1);
}

function detectGpuModel(): string | null {
  // allow override for testing
  if (process.env.GPU_MODEL && process.env.GPU_MODEL.trim()) {
    return process.env.GPU_MODEL.trim();
  }

  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name --format=csv,noheader,nounits',
      { encoding: 'utf8' },
    );
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return line || null;
  } catch (e: any) {
    console.log(
      '[miner] GPU auto-detect failed (nvidia-smi missing or no NVIDIA GPU).',
      e?.message || '',
    );
    return null;
  }
}

const GPU_MODEL = detectGpuModel();
console.log(
  `[miner] boot WALLET=${WALLET} HOST_ID=${HOST_ID} DEVICE_ID=${DEVICE_ID} COORD=${COORD}`,
);
console.log(`[miner] GPU_MODEL detected="${GPU_MODEL || ''}"`);

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
  site?: string | null;
  gpuReportedModel?: string | null;
  gpuVerified?: boolean;
};

type ShareResp = { ok?: boolean; total?: number; error?: string };

type AiJob = {
  id: number;
  wallet: string;
  model_id: string;
  host_id: string | null;
  prompt: string;
  status: string;
  result?: string | null;
  error?: string | null;
  created_ts: number;
  updated_ts: number;
  taken_device_id?: string | null;
  taken_ts?: number | null;
};

type AiJobNextResp = {
  ok?: boolean;
  job?: AiJob | null;
  error?: string;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -------------------- Core coordinator calls --------------------

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
        gpuModel: GPU_MODEL || null,
      }),
    });
    const j = (await r.json()) as HelloResp;
    return j;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'hello_failed' };
  }
}

// Read enabled flag + gpu info from /host-state
async function hostState(): Promise<HostState | null> {
  try {
    const r = await fetch(
      `${COORD}/host-state?hostId=${encodeURIComponent(HOST_ID)}`,
    );
    return (await r.json()) as HostState;
  } catch {
    return null;
  }
}

// send fake mining shares (existing PoW-ish loop)
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

// -------------------- AI job worker helpers --------------------

async function fetchNextAiJob(): Promise<AiJob | null> {
  try {
    const url = new URL(`${COORD}/ai/jobs/next`);
    url.searchParams.set('hostId', HOST_ID);
    url.searchParams.set('deviceId', DEVICE_ID);

    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log(
        `[ai-worker] /ai/jobs/next http_${r.status} ${txt.slice(0, 120)}`,
      );
      return null;
    }

    const j = (await r.json()) as AiJobNextResp;
    if (!j.ok) {
      if (j.error) console.log('[ai-worker] next error', j.error);
      return null;
    }

    return j.job ?? null;
  } catch (e: any) {
    console.log('[ai-worker] next failed', e?.message || e);
    return null;
  }
}

async function submitAiJobResult(
  jobId: number,
  result: string,
  error?: string,
): Promise<void> {
  try {
    const r = await fetch(`${COORD}/ai/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result,
        error: error || null,
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.log(
        `[ai-worker] result http_${r.status} ${txt.slice(0, 120)}`,
      );
    }
  } catch (e: any) {
    console.log('[ai-worker] result failed', e?.message || e);
  }
}

// -------------------- Mining worker (existing) --------------------

async function miningWorker() {
  for (;;) {
    const h = await hello();
    if (!h.ok) {
      console.log(`[miner] hello failed ${h.error || ''}`.trim());
      await delay(2000);
      continue;
    }
    if (!h.bound) {
      console.log(
        `[miner] not bound yet (host=${HOST_ID} device=${DEVICE_ID}). Waiting…`,
      );
      await delay(2000);
      continue;
    }

    const s = await hostState();
    if (!s?.enabled) {
      console.log('[miner] host is DISABLED. Waiting to be enabled…');
      await delay(3000);
      continue;
    }

    const reported = s.gpuReportedModel || null;
    const gpuVerified = !!s.gpuVerified;

    if (!gpuVerified) {
      console.log(
        `[miner] host enabled, GPU not verified yet. Coordinator sees="${reported || 'none'}".`,
      );
      await delay(5000);
      continue;
    }

    console.log(
      '[miner] ENABLED, BOUND & GPU VERIFIED. Starting share loop.',
    );

    // Share loop
    while (true) {
      // re-check enabled / gpuVerified every so often
      const randomGate = Math.random() < 0.05;
      if (randomGate) {
        const now = await hostState();
        if (!now?.enabled || !now.gpuVerified) {
          console.log(
            '[miner] host turned OFF or GPU lost verification. Pausing…',
          );
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

// -------------------- AI worker (new) --------------------

async function aiWorker() {
  console.log('[ai-worker] starting AI job worker loop');
  for (;;) {
    try {
      const s = await hostState();
      if (!s?.enabled || !s.gpuVerified) {
        console.log(
          '[ai-worker] host disabled or GPU not verified; sleeping…',
        );
        await delay(5000);
        continue;
      }

      const job = await fetchNextAiJob();
      if (!job) {
        await delay(4000);
        continue;
      }

      console.log(
        `[ai-worker] claimed job id=${job.id} model=${job.model_id} wallet=${job.wallet}`,
      );
      console.log('[ai-worker] prompt:\n', job.prompt);

      // --- Stubbed "model" compute for now ---
      const fakeResult =
        `[SIMULATED MODEL OUTPUT]\n\n` +
        `Model: ${job.model_id}\nHost: ${HOST_ID} / ${DEVICE_ID}\n\n` +
        `Prompt:\n${job.prompt.slice(0, 200)}${
          job.prompt.length > 200 ? '…' : ''
        }`;

      // Simulate some compute time
      await delay(1500);

      await submitAiJobResult(job.id, fakeResult);
      console.log(`[ai-worker] completed job id=${job.id}`);
    } catch (e: any) {
      console.error('[ai-worker] error', e?.message || e);
      await delay(5000);
    }
  }
}

// -------------------- Startup --------------------

async function start() {
  await Promise.all([miningWorker(), aiWorker()]);
}

start().catch((e) => {
  console.error('[miner] fatal', e);
  process.exit(1);
});
